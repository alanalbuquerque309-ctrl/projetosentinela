import type { UnifiedAnalysis } from "./aiService";

function emptyInsufficient(): UnifiedAnalysis {
  return {
    status: "QUALIDADE_INSUFICIENTE",
    categoria: "financeira",
    titulo: "Nao identificado",
    valor: "",
    vencimento: "",
    imposto_estimado: "",
    beneficiario: "",
    alerta_fraude: false,
    motivo_fraude: "",
    confidence: 0,
    provider: "gemini",
    raw: "",
  };
}

/**
 * Junta N analises de paginas num unico registo para persistir / responder ao cliente.
 */
export function mergePdfPageAnalyses(results: UnifiedAnalysis[]): UnifiedAnalysis {
  if (results.length === 0) return emptyInsufficient();
  if (results.length === 1) return results[0];

  const allBad = results.every((r) => r.status === "QUALIDADE_INSUFICIENTE");
  if (allBad) {
    return {
      ...emptyInsufficient(),
      raw: results.map((r, idx) => `--- Pagina ${idx + 1} ---\n${r.raw}`).join("\n\n"),
      confidence: Math.max(0, ...results.map((r) => r.confidence)),
    };
  }

  const usable = results.filter((r) => r.status !== "QUALIDADE_INSUFICIENTE");
  const primary = usable.reduce((a, b) => (a.confidence >= b.confidence ? a : b));

  const anyFraud = results.some((r) => r.alerta_fraude);
  const fraudReasons = results
    .filter((r) => r.motivo_fraude?.trim())
    .map((r) => r.motivo_fraude);

  return {
    ...primary,
    alerta_fraude: anyFraud,
    motivo_fraude: anyFraud
      ? fraudReasons.join(" | ") || primary.motivo_fraude
      : primary.motivo_fraude,
    raw: results.map((r, idx) => `--- Pagina ${idx + 1} ---\n${r.raw}`).join("\n\n"),
    confidence:
      usable.length > 0
        ? usable.reduce((s, r) => s + r.confidence, 0) / usable.length
        : primary.confidence,
  };
}
