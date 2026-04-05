import CryptoJS from "crypto-js";

export type UnifiedAnalysis = {
  status: "OK" | "INCONCLUSIVO" | "QUALIDADE_INSUFICIENTE";
  categoria: "financeira" | "saude" | "legal";
  titulo: string;
  valor: string;
  vencimento: string;
  imposto_estimado: string;
  beneficiario: string;
  alerta_fraude: boolean;
  motivo_fraude: string;
  confidence: number;
  provider: "gemini" | "openai";
  raw: string;
};

type StoredEncryptedFields = {
  titulo: string;
  beneficiario: string;
  motivo_fraude: string;
};

type AnalyzeInput = {
  imageBase64: string;
  mimeType: string;
  geminiApiKey: string;
  openAiApiKey?: string;
};

type PrecheckResult = {
  ok: boolean;
  issues: string[];
};

const TRUSTED_BENEFICIARIES = [
  "receita federal",
  "inss",
  "prefeitura",
  "fazenda",
  "energia",
  "agua",
  "internet",
  "telefone",
  "hospital",
  "clinica",
];

const SUSPICIOUS_TOKENS = [
  "gift card",
  "criptomoeda",
  "wallet",
  "intermediario",
  "urgente",
  "pix imediato",
  "taxa de desbloqueio",
];

const SYSTEM_PROMPT =
  "Analise o documento (imagem ou PDF, inclusive varias paginas) e responda APENAS JSON com os campos: " +
  "status(OK|INCONCLUSIVO|QUALIDADE_INSUFICIENTE), confidence(0-1), " +
  "categoria(financeira|saude|legal), titulo, valor, vencimento, imposto_estimado, beneficiario, " +
  "alerta_fraude(boolean), motivo_fraude. " +
  "Priorize contas a pagar: boletos, faturas, NF-e, recibos, extratos bancarios, faturas de cartao. " +
  "Para EXTRATO ou PDF longo: categoria=financeira; titulo = instituicao + tipo + periodo; " +
  "valor = saldo final recente ou total a pagar da fatura; vencimento = fim do periodo ou vencimento da fatura. " +
  "Para cupom/recibo: titulo = estabelecimento, valor = total pago. " +
  "Para NF: TOTAL a pagar; EMITENTE em titulo ou beneficiario. " +
  "Se for CONTRATO ou documento juridico (aluguel, compra e venda, financiamento, emprestimo, prestacao de servicos, etc.): " +
  "categoria=legal. titulo = tipo do contrato + resumo em PORTUGUES SIMPLES (sem juridiquês): o que as partes combinam, " +
  "prazos e valores em linguagem de leigo; se couber, cite clausulas que merecem ATENCAO (multa, fidelidade, renovacao automatica). " +
  "valor = valores principais (ex.: parcela, total, entrada) ou 'varios — ver contrato'; vencimento = fim de vigencia ou proxima data relevante; " +
  "imposto_estimado pode ser vazio ou N/A; beneficiario = outra parte (locador, banco, vendedor) se identificavel. " +
  "alerta_fraude=true se houver sinais de clausula abusiva ou documento suspeito; motivo_fraude = explicacao curta e simples, sem alarmismo. " +
  "Documento ilegivel ou protegido por senha: status=QUALIDADE_INSUFICIENTE e confidence <= 0.4.";

function stripCodeFence(text: string): string {
  return text
    .trim()
    .replace(/^```json/i, "")
    .replace(/^```/i, "")
    .replace(/```$/, "")
    .trim();
}

const ENC_PREFIX = "enc::";

function resolveEncryptionKey(preferServer = true): string {
  const key =
    (preferServer ? process.env.SENTINELA_ENCRYPTION_KEY : undefined) ||
    process.env.SENTINELA_NEXT_PUBLIC_ENCRYPTION_KEY ||
    process.env.SENTINELA_ENCRYPTION_KEY ||
    "";
  return key;
}

export function encryptText(value: string, preferServer = true): string {
  const key = resolveEncryptionKey(preferServer);
  if (!key || !value) return value;
  const encrypted = CryptoJS.AES.encrypt(value, key).toString();
  return `${ENC_PREFIX}${encrypted}`;
}

export function decryptText(value: string, preferServer = false): string {
  const key = resolveEncryptionKey(preferServer);
  if (!key || !value) return value;
  if (!value.startsWith(ENC_PREFIX)) return value;
  try {
    const encrypted = value.slice(ENC_PREFIX.length);
    const bytes = CryptoJS.AES.decrypt(encrypted, key);
    const text = bytes.toString(CryptoJS.enc.Utf8);
    return text || value;
  } catch {
    return value;
  }
}

export function encryptSensitiveFields(analysis: UnifiedAnalysis): StoredEncryptedFields {
  return {
    titulo: encryptText(analysis.titulo, true),
    beneficiario: encryptText(analysis.beneficiario, true),
    motivo_fraude: encryptText(analysis.motivo_fraude, true),
  };
}

export function decryptSensitiveFields<T extends { titulo: string; beneficiario?: string; motivo_fraude?: string }>(
  row: T,
): T {
  return {
    ...row,
    titulo: decryptText(row.titulo, false),
    beneficiario: decryptText(row.beneficiario ?? "", false),
    motivo_fraude: decryptText(row.motivo_fraude ?? "", false),
  };
}

function normalize(parsed: Partial<UnifiedAnalysis>, provider: UnifiedAnalysis["provider"], raw: string): UnifiedAnalysis {
  const conf = Number(parsed.confidence ?? 0.5);
  const safeConfidence = Number.isFinite(conf)
    ? Math.max(0, Math.min(1, conf))
    : 0.5;

  const statusInput = parsed.status ?? "INCONCLUSIVO";
  const status =
    statusInput === "OK" ||
    statusInput === "INCONCLUSIVO" ||
    statusInput === "QUALIDADE_INSUFICIENTE"
      ? statusInput
      : "INCONCLUSIVO";

  const asText = (value: unknown, fallback = ""): string => {
    if (typeof value === "string") return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value).trim();
    return fallback;
  };

  return {
    status,
    categoria:
      parsed.categoria === "financeira" ||
      parsed.categoria === "saude" ||
      parsed.categoria === "legal"
        ? parsed.categoria
        : "financeira",
    titulo: asText(parsed.titulo, "Nao identificado") || "Nao identificado",
    valor: asText(parsed.valor, "Nao identificado") || "Nao identificado",
    vencimento: asText(parsed.vencimento, "Nao identificado") || "Nao identificado",
    imposto_estimado: asText(parsed.imposto_estimado, "Nao identificado") || "Nao identificado",
    beneficiario: asText(parsed.beneficiario, ""),
    alerta_fraude: Boolean(parsed.alerta_fraude),
    motivo_fraude: asText(parsed.motivo_fraude, ""),
    confidence: safeConfidence,
    provider,
    raw,
  };
}

function parseProviderJson(rawText: string, provider: UnifiedAnalysis["provider"]): UnifiedAnalysis {
  const clean = stripCodeFence(rawText);
  const parsed = JSON.parse(clean) as Partial<UnifiedAnalysis>;
  return normalize(parsed, provider, rawText);
}

function applyFraudRules(base: UnifiedAnalysis): UnifiedAnalysis {
  if (base.categoria !== "financeira") return base;

  const tituloLower = base.titulo.toLowerCase();
  const looksLikeStatementOrInvoice =
    /extrato|demonstrativo|resumo da fatura|fatura do cart|fatura\s|comprovante|saldo|conta corrente|poupanca/i.test(
      tituloLower,
    );
  if (looksLikeStatementOrInvoice) return base;

  const beneficiary = base.beneficiario.toLowerCase().trim();
  const looksTrusted = TRUSTED_BENEFICIARIES.some((item) =>
    beneficiary.includes(item),
  );
  const hasSuspiciousToken = SUSPICIOUS_TOKENS.some((token) =>
    beneficiary.includes(token) || base.titulo.toLowerCase().includes(token),
  );
  const inconsistent = !beneficiary || (!looksTrusted && hasSuspiciousToken);

  if (!inconsistent) return base;

  return {
    ...base,
    alerta_fraude: true,
    motivo_fraude:
      base.motivo_fraude ||
      "Beneficiario inconsistente para documento financeiro. Confirme CNPJ/CPF antes de pagar.",
  };
}

function needsFallback(result: UnifiedAnalysis): boolean {
  if (result.status === "QUALIDADE_INSUFICIENTE") return false;
  if (result.status === "INCONCLUSIVO") return true;
  return result.confidence < 0.65;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJsonWithRetry(
  url: string,
  init: RequestInit,
  opts: { timeoutMs: number; retries: number; provider: "gemini" | "openai" },
): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= opts.retries; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, init, opts.timeoutMs);
      if (response.ok) return response;

      const text = await response.text();
      const msg = `${opts.provider.toUpperCase()}_HTTP_${response.status}: ${text.slice(0, 600)}`;
      const retriable = response.status === 408 || response.status === 429 || response.status >= 500;
      if (!retriable || attempt === opts.retries) {
        throw new Error(msg);
      }
      lastError = new Error(msg);
      await sleep(350 * (attempt + 1));
      continue;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      const isAbort = /aborted|timeout/i.test(e.message);
      const retriable = isAbort || /network|fetch/i.test(e.message);
      if (!retriable || attempt === opts.retries) {
        throw new Error(`${opts.provider.toUpperCase()}_REQUEST_FAILED: ${e.message}`);
      }
      lastError = e;
      await sleep(350 * (attempt + 1));
    }
  }
  throw lastError || new Error(`${opts.provider.toUpperCase()}_UNKNOWN_FAILURE`);
}

function isPdfInput(input: AnalyzeInput): boolean {
  const m = input.mimeType.toLowerCase();
  return m === "application/pdf" || m === "application/x-pdf";
}

async function callGemini(input: AnalyzeInput): Promise<UnifiedAnalysis> {
  const timeoutMs = isPdfInput(input) ? 90000 : 25000;
  const response = await fetchJsonWithRetry(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${input.geminiApiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: SYSTEM_PROMPT },
              {
                inlineData: {
                  mimeType: isPdfInput(input) ? "application/pdf" : input.mimeType,
                  data: input.imageBase64,
                },
              },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
        },
      }),
    },
    { timeoutMs, retries: 1, provider: "gemini" },
  );

  const data = (await response.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
    }>;
  };

  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!rawText) throw new Error("Gemini sem resposta");
  return parseProviderJson(rawText, "gemini");
}

async function callOpenAI(input: AnalyzeInput): Promise<UnifiedAnalysis> {
  if (!input.openAiApiKey) {
    throw new Error("OPENAI_KEY_AUSENTE");
  }
  if (isPdfInput(input)) {
    throw new Error("OPENAI_PDF_NAO_SUPORTADO");
  }

  const response = await fetchJsonWithRetry(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.openAiApiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: "Analise esta imagem." },
              {
                type: "image_url",
                image_url: {
                  url: `data:${input.mimeType};base64,${input.imageBase64}`,
                },
              },
            ],
          },
        ],
      }),
    },
    { timeoutMs: 25000, retries: 1, provider: "openai" },
  );

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const rawText = data.choices?.[0]?.message?.content?.trim();
  if (!rawText) throw new Error("OpenAI sem resposta");
  return parseProviderJson(rawText, "openai");
}

export async function analyzeWithFallback(input: AnalyzeInput): Promise<UnifiedAnalysis> {
  const pdf = isPdfInput(input);

  let primary: UnifiedAnalysis;
  try {
    primary = applyFraudRules(await callGemini(input));
  } catch {
    if (pdf) {
      throw new Error("GEMINI_PDF_FALHOU");
    }
    const fromOpenAI = applyFraudRules(await callOpenAI(input));
    return fromOpenAI;
  }

  if (primary.status === "QUALIDADE_INSUFICIENTE") {
    if (input.openAiApiKey && !pdf) {
      try {
        const fallbackForQuality = applyFraudRules(await callOpenAI(input));
        if (fallbackForQuality.status !== "QUALIDADE_INSUFICIENTE") {
          return fallbackForQuality;
        }
      } catch {
        // Mantem retorno de qualidade insuficiente do Gemini se fallback falhar.
      }
    }
    return primary;
  }

  if (needsFallback(primary) && !pdf) {
    const fallback = applyFraudRules(await callOpenAI(input));
    if (fallback.status === "QUALIDADE_INSUFICIENTE") return fallback;
    if (fallback.confidence >= primary.confidence) return fallback;
  }

  if (primary.alerta_fraude && input.openAiApiKey && !pdf) {
    try {
      const secondOpinion = applyFraudRules(await callOpenAI(input));
      if (secondOpinion.alerta_fraude) {
        return {
          ...primary,
          motivo_fraude:
            primary.motivo_fraude ||
            secondOpinion.motivo_fraude ||
            "Risco financeiro elevado detectado por dupla checagem.",
        };
      }
    } catch {
      // Mantem resultado principal se a segunda opiniao falhar.
    }
  }

  return primary;
}

export function precheckProviders(input: {
  geminiApiKey?: string;
  openAiApiKey?: string;
}): PrecheckResult {
  const issues: string[] = [];
  const g = (input.geminiApiKey || "").trim();
  const o = (input.openAiApiKey || "").trim();

  if (!g) issues.push("SENTINELA_GEMINI_KEY ausente");
  if (g && g.length < 20) issues.push("SENTINELA_GEMINI_KEY com formato invalido");

  if (o && o.length < 20) issues.push("SENTINELA_OPENAI_KEY com formato invalido");
  if (!g && !o) issues.push("Nenhum provedor de IA configurado");

  return { ok: issues.length === 0, issues };
}
