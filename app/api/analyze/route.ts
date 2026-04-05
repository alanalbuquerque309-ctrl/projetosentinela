import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import {
  analyzeWithFallback,
  encryptSensitiveFields,
  precheckProviders,
  type UnifiedAnalysis,
} from "@/lib/aiService";
import { mergePdfPageAnalyses } from "@/lib/mergePdfAnalyses";
import { splitPdfToSinglePageBase64 } from "@/lib/pdfSplitServer";

type AnalyzePayload = {
  imageBase64?: string;
  mimeType?: string;
  deviceId?: string;
  qrText?: string;
};

const DEFAULT_MAX_BYTES = 12 * 1024 * 1024;
const DEFAULT_MAX_PDF_PAGES = 10;

function approxBytesFromBase64(b64: string): number {
  const len = b64.length;
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((len * 3) / 4) - padding);
}

export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    const supabaseUrl = process.env.SENTINELA_NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey = process.env.SENTINELA_NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const geminiKey = process.env.SENTINELA_GEMINI_KEY;
    const openAiKey = process.env.SENTINELA_OPENAI_KEY;

    if (!supabaseUrl || !supabaseAnonKey || !geminiKey) {
      return NextResponse.json(
        { error: "Ambiente incompleto. Configure .env.local." },
        { status: 500 },
      );
    }

    const precheck = precheckProviders({ geminiApiKey: geminiKey, openAiApiKey: openAiKey });
    if (!precheck.ok) {
      return NextResponse.json(
        {
          error: "Configuracao de IA invalida.",
          details: precheck.issues.join("; "),
        },
        { status: 500 },
      );
    }

    const body = (await req.json()) as AnalyzePayload;
    if (!body.imageBase64 || !body.deviceId) {
      return NextResponse.json(
        { error: "Payload invalido. Envie imageBase64 e deviceId." },
        { status: 400 },
      );
    }

    const maxBytesRaw = Number(process.env.SENTINELA_MAX_UPLOAD_BYTES || String(DEFAULT_MAX_BYTES));
    const maxBytes = Number.isFinite(maxBytesRaw) && maxBytesRaw > 0 ? maxBytesRaw : DEFAULT_MAX_BYTES;
    const approx = approxBytesFromBase64(body.imageBase64);
    if (approx > maxBytes) {
      return NextResponse.json(
        {
          error: "Arquivo grande demais para analise.",
          details: `Tamanho aproximado ${Math.round(approx / 1024 / 1024)} MB; limite ${Math.round(maxBytes / 1024 / 1024)} MB. Tente um PDF menor ou foto por pagina.`,
        },
        { status: 413 },
      );
    }

    const supabase = createClient(supabaseUrl, supabaseAnonKey);
    const bypassLimit = ["1", "true", "yes", "on"].includes(
      String(process.env.SENTINELA_BYPASS_LIMIT || "")
        .trim()
        .toLowerCase(),
    );
    const freeLimitRaw = Number(process.env.SENTINELA_FREE_SCAN_LIMIT || "2");
    const freeScanLimit = Number.isFinite(freeLimitRaw) ? Math.max(0, Math.floor(freeLimitRaw)) : 2;
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const { count, error: countError } = await supabase
      .from("sentinela_scans")
      .select("id", { count: "exact", head: true })
      .eq("device_id", body.deviceId)
      .gte("created_at", monthStart.toISOString());

    if (!bypassLimit && !countError && (count ?? 0) >= freeScanLimit) {
      return NextResponse.json(
        {
          error: "Limite gratuito excedido.",
          requiresUpgrade: true,
          scansUsed: count,
          scanLimit: freeScanLimit,
        },
        { status: 402 },
      );
    }

    const mimeLower = (body.mimeType || "image/jpeg").toLowerCase();
    const isPdf = mimeLower.includes("pdf");

    let structured: UnifiedAnalysis;
    let analyzedPages: number | undefined;

    try {
      if (isPdf) {
        let pageBase64s: string[];
        try {
          const pdfBytes = Buffer.from(body.imageBase64, "base64");
          pageBase64s = await splitPdfToSinglePageBase64(pdfBytes);
        } catch (pdfErr) {
          console.error("pdf_split_error", pdfErr);
          return NextResponse.json(
            {
              error:
                "Nao foi possivel abrir o PDF. Pode estar protegido por senha ou corrompido.",
              details: String(pdfErr),
            },
            { status: 400 },
          );
        }

        const maxPagesRaw = Number(
          process.env.SENTINELA_MAX_PDF_PAGES || String(DEFAULT_MAX_PDF_PAGES),
        );
        const maxPages =
          Number.isFinite(maxPagesRaw) && maxPagesRaw > 0
            ? Math.floor(maxPagesRaw)
            : DEFAULT_MAX_PDF_PAGES;

        if (pageBase64s.length > maxPages) {
          return NextResponse.json(
            {
              error: `PDF com ${pageBase64s.length} paginas. Limite atual: ${maxPages}.`,
              details: "Divida o extrato em partes menores ou exporte menos paginas.",
            },
            { status: 400 },
          );
        }

        analyzedPages = pageBase64s.length;
        const perPage: UnifiedAnalysis[] = [];
        for (let i = 0; i < pageBase64s.length; i += 1) {
          const pageResult = await analyzeWithFallback({
            imageBase64: pageBase64s[i],
            mimeType: "application/pdf",
            geminiApiKey: geminiKey,
            openAiApiKey: openAiKey,
          });
          perPage.push(pageResult);
        }
        structured = mergePdfPageAnalyses(perPage);
      } else {
        structured = await analyzeWithFallback({
          imageBase64: body.imageBase64,
          mimeType: body.mimeType || "image/jpeg",
          geminiApiKey: geminiKey,
          openAiApiKey: openAiKey,
        });
      }
    } catch (providerError) {
      console.error("analyze_provider_error", providerError);
      const msg = String(providerError);
      return NextResponse.json(
        {
          error: isPdf
            ? "Falha ao ler o PDF. Verifique se nao esta protegido por senha e tente de novo."
            : "Falha ao contactar provedores de IA.",
          details: msg,
        },
        { status: 502 },
      );
    }

    if (structured.status === "QUALIDADE_INSUFICIENTE") {
      return NextResponse.json({ ...structured, analyzedPages }, { status: 200 });
    }

    const encrypted = encryptSensitiveFields(structured);

    const { data: insertedRow, error: insertError } = await supabase
      .from("sentinela_scans")
      .insert({
        device_id: body.deviceId,
        categoria: "financeira",
        titulo: encrypted.titulo,
        valor: structured.valor,
        vencimento: structured.vencimento,
        imposto_estimado: structured.imposto_estimado,
        beneficiario: encrypted.beneficiario,
        alerta_fraude: structured.alerta_fraude ?? false,
        motivo_fraude: encrypted.motivo_fraude,
        raw_response: body.qrText
          ? `${structured.raw}\n[QR_CODE]\n${body.qrText}`
          : structured.raw,
      })
      .select("id")
      .single();

    return NextResponse.json({
      ...structured,
      analyzedPages,
      persisted: !insertError,
      persistedId: insertedRow?.id ?? null,
      persistenceError: insertError?.message ?? null,
    });
  } catch (error) {
    console.error("analyze_route_unhandled_error", error);
    return NextResponse.json(
      { error: "Erro interno ao analisar imagem.", details: String(error) },
      { status: 500 },
    );
  }
}
