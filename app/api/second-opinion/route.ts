import { NextResponse } from "next/server";

type Payload = {
  rawJson?: string;
  titulo?: string;
  valor?: string;
  vencimento?: string;
};

export async function POST(req: Request) {
  try {
    const openAiKey = process.env.SENTINELA_OPENAI_KEY;
    if (!openAiKey) {
      return NextResponse.json(
        { error: "SENTINELA_OPENAI_KEY nao configurada." },
        { status: 500 },
      );
    }

    const body = (await req.json()) as Payload;
    if (!body.rawJson) {
      return NextResponse.json(
        { error: "rawJson obrigatorio para segunda opiniao." },
        { status: 400 },
      );
    }

    const prompt =
      "Voce e um auditor financeiro e de contratos. Leia o JSON bruto de um scan e devolva APENAS JSON com: " +
      "nivel_risco(BAIXO|MEDIO|ALTO), resumo_executivo, taxas_suspeitas(array de strings), " +
      "letras_miudas(array de strings), recomendacao_objetiva. " +
      "Se nao houver risco relevante, mantenha arrays vazios.";

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openAiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: prompt },
          {
            role: "user",
            content:
              `titulo=${body.titulo ?? ""}\nvalor=${body.valor ?? ""}\nvencimento=${body.vencimento ?? ""}\nraw_json=${body.rawJson}`,
          },
        ],
      }),
    });

    if (!response.ok) {
      return NextResponse.json(
        { error: "Falha na revisao GPT-4o.", details: await response.text() },
        { status: 502 },
      );
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = data.choices?.[0]?.message?.content?.trim() ?? "{}";

    let parsed: {
      nivel_risco?: string;
      resumo_executivo?: string;
      taxas_suspeitas?: string[];
      letras_miudas?: string[];
      recomendacao_objetiva?: string;
    };
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { resumo_executivo: raw };
    }

    return NextResponse.json({
      nivel_risco: parsed.nivel_risco ?? "MEDIO",
      resumo_executivo: parsed.resumo_executivo ?? "Sem conclusao detalhada.",
      taxas_suspeitas: parsed.taxas_suspeitas ?? [],
      letras_miudas: parsed.letras_miudas ?? [],
      recomendacao_objetiva:
        parsed.recomendacao_objetiva ?? "Revise o documento antes de pagar.",
    });
  } catch (error) {
    return NextResponse.json(
      { error: "Erro interno na segunda opiniao.", details: String(error) },
      { status: 500 },
    );
  }
}
