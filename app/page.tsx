"use client";

import { createClient } from "@supabase/supabase-js";
import {
  Bell,
  CalendarRange,
  Camera,
  ChevronDown,
  ChevronUp,
  Database,
  Download,
  LayoutGrid,
  Receipt,
  Repeat,
  Share2,
  Shield,
  ShieldAlert,
  Target,
  Wallet,
  X,
} from "lucide-react";
import { PDFDocument } from "pdf-lib";
import { decryptSensitiveFields, encryptText } from "@/lib/aiService";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type AnalyzeResponse = {
  status?: "OK" | "INCONCLUSIVO" | "QUALIDADE_INSUFICIENTE";
  categoria: "financeira" | "saude" | "legal";
  titulo: string;
  valor: string;
  vencimento: string;
  imposto_estimado: string;
  alerta_fraude?: boolean;
  motivo_fraude?: string;
  requiresUpgrade?: boolean;
  persisted?: boolean;
  persistedId?: number | null;
  persistenceError?: string | null;
  raw?: string;
  details?: string;
  error?: string;
  analyzedPages?: number;
};

type ScanRecord = {
  id: number;
  created_at: string;
  categoria: "financeira" | "saude" | "legal";
  titulo: string;
  valor: string;
  vencimento: string;
  imposto_estimado: string;
  beneficiario?: string;
  alerta_fraude: boolean;
  motivo_fraude?: string;
  raw_response?: string;
};

type TabKey = "contas" | "organizador";
type FinanceFilter = "tudo" | "vencendo7" | "pagos";
type SecondOpinion = {
  nivel_risco: "BAIXO" | "MEDIO" | "ALTO";
  resumo_executivo: string;
  taxas_suspeitas: string[];
  letras_miudas: string[];
  recomendacao_objetiva: string;
};

type WindowWithBarcodeDetector = Window & {
  BarcodeDetector?: new (opts: { formats: string[] }) => {
    detect: (source: ImageBitmapSource) => Promise<Array<{ rawValue?: string }>>;
  };
};

type PaymentData = {
  code: string | null;
  paymentUrl: string | null;
  source: string;
};

function extractPaymentUrlFromText(src: string): string | null {
  const m = src.match(/https?:\/\/[^\s"'<>]+/i);
  return m?.[0] ?? null;
}

function extractBoletoCodeFromText(src: string): string | null {
  const digitsOnly = src.replace(/\D/g, "");
  const m44 = digitsOnly.match(/\d{44}/);
  if (m44) return m44[0];
  const m47 = digitsOnly.match(/\d{47}/);
  if (m47) return m47[0];
  const m48 = digitsOnly.match(/\d{48}/);
  if (m48) return m48[0];
  return null;
}

function extractPaymentData(scan: ScanRecord): PaymentData {
  const src = `${scan.raw_response ?? ""}\n${scan.titulo ?? ""}\n${scan.valor ?? ""}`;
  const paymentUrl = extractPaymentUrlFromText(src);
  const code = extractBoletoCodeFromText(src);
  return {
    code,
    paymentUrl,
    source: src,
  };
}

function getOrCreateDeviceId() {
  const key = "sentinela_v1_device_id";
  const stored = localStorage.getItem(key);
  if (stored) return stored;
  const created = crypto.randomUUID();
  localStorage.setItem(key, created);
  return created;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Falha ao ler ficheiro de imagem"));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Falha ao decodificar imagem"));
    img.src = src;
  });
}

const MAX_UPLOAD_BYTES_CLIENT = 12 * 1024 * 1024;
const PDF_SEC_PER_PAGE_EST = 28;

function isPdfFile(file: File): boolean {
  const n = file.name.toLowerCase();
  return file.type === "application/pdf" || n.endsWith(".pdf");
}

function formatCountdown(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

function getWeekRangeLabel(d: Date): string {
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = start.getDay();
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  start.setDate(start.getDate() + mondayOffset);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const fmt = (x: Date) =>
    x.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });
  return `${fmt(start)} – ${fmt(end)}`;
}

async function getPdfPageCount(file: File): Promise<number> {
  const buf = await file.arrayBuffer();
  const doc = await PDFDocument.load(buf, { ignoreEncryption: true });
  return doc.getPageCount();
}

async function readFileAsAnalyzePayload(
  file: File,
): Promise<{ imageBase64: string; mimeType: string }> {
  if (isPdfFile(file)) {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    const imageBase64 = btoa(binary);
    return { imageBase64, mimeType: "application/pdf" };
  }
  return optimizePhotoForUpload(file);
}

async function optimizePhotoForUpload(file: File): Promise<{ imageBase64: string; mimeType: string }> {
  const dataUrl = await readFileAsDataUrl(file);
  const img = await loadImage(dataUrl);

  // Reduz tamanho para evitar falhas de memória/rede em uploads muito grandes.
  const maxDim = 1600;
  const scale = Math.min(1, maxDim / Math.max(img.width || 1, img.height || 1));
  const targetW = Math.max(1, Math.round(img.width * scale));
  const targetH = Math.max(1, Math.round(img.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Falha no canvas de otimização");
  ctx.drawImage(img, 0, 0, targetW, targetH);

  const optimizedDataUrl = canvas.toDataURL("image/jpeg", 0.9);
  const imageBase64 = optimizedDataUrl.split(",")[1] ?? "";
  if (!imageBase64) throw new Error("Imagem otimizada vazia");
  return { imageBase64, mimeType: "image/jpeg" };
}

async function detectCodesFromFile(file: File): Promise<string[]> {
  const Ctor = (window as WindowWithBarcodeDetector).BarcodeDetector;
  if (!Ctor || typeof createImageBitmap !== "function") return [];
  try {
    const detector = new Ctor({
      formats: ["qr_code", "code_128", "itf", "ean_13", "ean_8", "upc_a", "upc_e", "pdf417"],
    });
    const bitmap = await createImageBitmap(file);
    const results = await detector.detect(bitmap);
    const values = (results ?? [])
      .map((item) => item?.rawValue?.trim() || "")
      .filter(Boolean);
    return Array.from(new Set(values));
  } catch {
    return [];
  }
}

function parseMoney(raw: string): number {
  const normalized = raw
    .replace(/[^\d,.-]/g, "")
    .replace(/\./g, "")
    .replace(",", ".");
  const value = Number.parseFloat(normalized);
  return Number.isFinite(value) ? value : 0;
}

function parseVencimentoDate(vencimento: string): Date | null {
  const txt = vencimento.trim();
  const br = txt.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (br) {
    const d = new Date(Number(br[3]), Number(br[2]) - 1, Number(br[1]));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const iso = new Date(txt);
  return Number.isNaN(iso.getTime()) ? null : iso;
}

function isMarkedAsPaid(scan: ScanRecord): boolean {
  const t = scan.titulo.toLowerCase();
  return /\bpago\b|\bquitado\b|\bpaid\b|\bliquidado\b/.test(t);
}

function formatBRL(value: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(value);
}

type SpendTier = "confortavel" | "apertado" | "evite";

function computeSpendAdvice(
  amount: number,
  leftover: number,
  cushion: number,
): { tier: SpendTier; afterSpend: number; title: string; detail: string } {
  const after = leftover - amount;
  const soft = Math.max(cushion, 0);
  if (after >= soft * 2) {
    return {
      tier: "confortavel",
      afterSpend: after,
      title: "Pode ir tranquilo",
      detail: `Depois desse gasto sobram cerca de ${formatBRL(after)} com base no que ja registrou. Sem promessa de ficar rico — e menos susto no fim do mes.`,
    };
  }
  if (after >= soft) {
    return {
      tier: "apertado",
      afterSpend: after,
      title: "Da, mas o mes fica apertado",
      detail: `Soberia uns ${formatBRL(after)} depois do gasto. Vale planejar cortar algo pequeno ou adiar outra compra se quiser folga.`,
    };
  }
  if (after >= 0) {
    return {
      tier: "apertado",
      afterSpend: after,
      title: "Arriscado",
      detail: `Tecnicamente cabe, mas sobram apenas ${formatBRL(after)}. Melhor esperar o proximo rendimento ou revisar uma conta antes.`,
    };
  }
  return {
    tier: "evite",
    afterSpend: after,
    title: "Melhor nao agora",
    detail: `Com o que registrou, esse gasto deixa saldo negativo de cerca de ${formatBRL(Math.abs(after))}. Nada de panico — e so sinal para adiar ou ajustar.`,
  };
}

function isDueSoon(vencimento: string): boolean {
  const date = parseVencimentoDate(vencimento);
  if (!date) return false;
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const days = diffMs / (1000 * 60 * 60 * 24);
  return days >= 0 && days <= 7;
}

function isOverdue(scan: ScanRecord): boolean {
  if (isMarkedAsPaid(scan)) return false;
  const due = parseVencimentoDate(scan.vencimento);
  if (!due) return false;
  const endOfDueDay = new Date(due);
  endOfDueDay.setHours(23, 59, 59, 999);
  return Date.now() > endOfDueDay.getTime();
}

function isBeneficiaryInconsistent(scan: ScanRecord): boolean {
  return /inconsisten|beneficiario/i.test(
    `${scan.motivo_fraude ?? ""} ${scan.raw_response ?? ""}`,
  );
}

function isFinanceRisk(scan: ScanRecord): boolean {
  return scan.alerta_fraude || isBeneficiaryInconsistent(scan);
}

type SavingsGoal = {
  id: string;
  nome: string;
  valorAlvo: number;
  valorAtual: number;
  dataAlvo?: string;
};

function goalDateHint(dataAlvo?: string): string | null {
  if (!dataAlvo) return null;
  const d = new Date(`${dataAlvo}T12:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  const diff = Math.ceil((d.getTime() - Date.now()) / 86400000);
  if (diff > 45) return `~${Math.round(diff / 30)} meses no horizonte`;
  if (diff > 0) return `Faltam ${diff} dia(s) ate a data`;
  return "Data ja passou — atualize a meta se quiser";
}

const LS_USAGE_MODE = "sentinela_v2_usage_mode";
const LS_MONTHLY_INCOME = "sentinela_v2_monthly_income";
const LS_GOALS = "sentinela_v2_savings_goals";
const LS_SPEND_CUSHION = "sentinela_v2_spend_cushion";
const LS_FIXED = "sentinela_v2_fixed_expenses";
const LS_REMINDER_DUE = "sentinela_v2_reminder_due_enabled";

type FixedExpense = {
  id: string;
  nome: string;
  valor: number;
  diaVencimento: number;
  ativo: boolean;
};

function readFixedFromStorage(): FixedExpense[] {
  try {
    const raw = localStorage.getItem(LS_FIXED);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: FixedExpense[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const id = typeof o.id === "string" ? o.id : "";
      const nome = typeof o.nome === "string" ? o.nome : "Fixo";
      const valor = Number(o.valor);
      const dia = Number(o.diaVencimento);
      const ativo = o.ativo !== false;
      if (!id || !Number.isFinite(valor) || valor < 0) continue;
      const diaVencimento = Number.isFinite(dia) ? Math.min(28, Math.max(1, Math.floor(dia))) : 10;
      out.push({ id, nome, valor, diaVencimento, ativo });
    }
    return out;
  } catch {
    return [];
  }
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function reminderSentKey(scanId: number, dayIso: string): string {
  return `sentinela_v2_reminder_sent_${scanId}_${dayIso}`;
}

/** Avisos do browser: contas nao pagas com vencimento nas proximas 48h (uma vez por dia por conta). */
function notifyUpcomingDues(scans: ScanRecord[]): void {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const now = Date.now();
  const horizonMs = 48 * 60 * 60 * 1000;
  const day = todayIso();
  for (const s of scans) {
    if (s.categoria !== "financeira") continue;
    if (isMarkedAsPaid(s)) continue;
    const due = parseVencimentoDate(s.vencimento);
    if (!due) continue;
    const endOfDueDay = new Date(due);
    endOfDueDay.setHours(23, 59, 59, 999);
    if (endOfDueDay.getTime() < now) continue;
    if (endOfDueDay.getTime() > now + horizonMs) continue;
    try {
      const k = reminderSentKey(s.id, day);
      if (localStorage.getItem(k)) continue;
      const titulo = s.titulo.length > 70 ? `${s.titulo.slice(0, 67)}...` : s.titulo;
      new Notification("Sentinela — vencimento em breve", {
        body: `${titulo} | ${s.vencimento} | ${s.valor}`,
        tag: `sentinela-due-${s.id}-${day}`,
      });
      localStorage.setItem(k, "1");
    } catch {
      /* ignore */
    }
  }
}

function readMonthlyIncomeFromStorage(): number {
  try {
    const raw = localStorage.getItem(LS_MONTHLY_INCOME);
    if (!raw) return 0;
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function readGoalsFromStorage(): SavingsGoal[] {
  try {
    const raw = localStorage.getItem(LS_GOALS);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: SavingsGoal[] = [];
    for (const g of parsed) {
      if (!g || typeof g !== "object") continue;
      const o = g as Record<string, unknown>;
      const id = typeof o.id === "string" ? o.id : "";
      const nome = typeof o.nome === "string" ? o.nome : "Meta";
      const valorAlvo = Number(o.valorAlvo);
      const valorAtual = Number(o.valorAtual);
      if (!id || !Number.isFinite(valorAlvo)) continue;
      const rawDate = typeof o.dataAlvo === "string" ? o.dataAlvo : undefined;
      const dataAlvo = rawDate?.match(/^\d{4}-\d{2}-\d{2}$/) ? rawDate : undefined;
      out.push({
        id,
        nome,
        valorAlvo: Math.max(0, valorAlvo),
        valorAtual: Number.isFinite(valorAtual) ? Math.max(0, valorAtual) : 0,
        dataAlvo,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export default function Home() {
  const appVersion = process.env.NEXT_PUBLIC_APP_VERSION ?? "dev-local";
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const nativeCaptureRef = useRef<HTMLInputElement | null>(null);
  const supabaseUrl = process.env.SENTINELA_NEXT_PUBLIC_SUPABASE_URL ?? "";
  const supabaseAnonKey = process.env.SENTINELA_NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
  const supabase = useMemo(() => {
    if (!supabaseUrl || !supabaseAnonKey) return null;
    return createClient(supabaseUrl, supabaseAnonKey);
  }, [supabaseUrl, supabaseAnonKey]);

  const [status, setStatus] = useState("Pronto");
  const [isScanning, setIsScanning] = useState(false);
  const [liveCameraOn, setLiveCameraOn] = useState(false);
  const [cameraReady, setCameraReady] = useState(true);
  const [cameraBlocked, setCameraBlocked] = useState(false);
  const [showUpgrade, setShowUpgrade] = useState(false);
  const [analysis, setAnalysis] = useState<AnalyzeResponse | null>(null);
  const [nextDue, setNextDue] = useState("Nenhum");
  const [toast, setToast] = useState<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const prepTimeoutRef = useRef<number | null>(null);
  const cameraReadyRef = useRef(false);
  const [cameraRequested, setCameraRequested] = useState(false);
  const [deviceId, setDeviceId] = useState<string>("");
  const [activeTab, setActiveTab] = useState<TabKey>("contas");
  const [usageMode, setUsageMode] = useState<"familia" | "mei" | null>(null);
  const [showUsageModal, setShowUsageModal] = useState(false);
  const [monthlyIncome, setMonthlyIncome] = useState(0);
  const [goals, setGoals] = useState<SavingsGoal[]>([]);
  const [spendAsk, setSpendAsk] = useState("");
  const [newGoalName, setNewGoalName] = useState("");
  const [newGoalTarget, setNewGoalTarget] = useState("");
  const [pdfWaitOverlay, setPdfWaitOverlay] = useState(false);
  const [pdfEtaSec, setPdfEtaSec] = useState(0);
  const [pdfPageCountOverlay, setPdfPageCountOverlay] = useState<number | null>(null);
  const [spendCushion, setSpendCushion] = useState(200);
  const [newGoalDate, setNewGoalDate] = useState("");
  const [fixedExpenses, setFixedExpenses] = useState<FixedExpense[]>([]);
  const [newFixedName, setNewFixedName] = useState("");
  const [newFixedValor, setNewFixedValor] = useState("");
  const [newFixedDia, setNewFixedDia] = useState(10);
  const [reminderDueEnabled, setReminderDueEnabled] = useState(false);
  const [shareCardBusy, setShareCardBusy] = useState(false);
  const [scans, setScans] = useState<ScanRecord[]>([]);
  const [financeFilter, setFinanceFilter] = useState<FinanceFilter>("tudo");
  const [onlyRisk, setOnlyRisk] = useState(false);
  const [successPulse, setSuccessPulse] = useState(false);
  const [secondOpinions, setSecondOpinions] = useState<Record<number, SecondOpinion>>({});
  const [secondOpinionLoading, setSecondOpinionLoading] = useState<Record<number, boolean>>(
    {},
  );
  const [lastPersistedId, setLastPersistedId] = useState<number | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [captureMeta, setCaptureMeta] = useState<{
    capturedAt: string | null;
    captured: boolean;
    analyzed: boolean;
    saved: boolean;
    persistedId: number | null;
    saveError: string | null;
  }>({
    capturedAt: null,
    captured: false,
    analyzed: false,
    saved: false,
    persistedId: null,
    saveError: null,
  });
  const [showUpdateBanner, setShowUpdateBanner] = useState(false);
  const [overdueModalOpen, setOverdueModalOpen] = useState(false);
  const [overdueActionBusy, setOverdueActionBusy] = useState(false);
  const [lastDetectedCodes, setLastDetectedCodes] = useState<string[]>([]);


  const loadScans = useCallback(
    async (currentDeviceId: string) => {
      if (!currentDeviceId || !supabase) return;
      const { data } = await supabase
        .from("sentinela_scans")
        .select(
          "id, created_at, categoria, titulo, valor, vencimento, imposto_estimado, beneficiario, alerta_fraude, motivo_fraude, raw_response",
        )
        .eq("device_id", currentDeviceId)
        .order("created_at", { ascending: false })
        .limit(80);
      const decrypted = ((data ?? []) as ScanRecord[]).map((row) =>
        decryptSensitiveFields(row),
      );
      setScans(decrypted);
    },
    [supabase],
  );

  async function attachStream(stream: MediaStream) {
    if (!videoRef.current) return;
    videoRef.current.srcObject = stream;
    videoRef.current.setAttribute("playsinline", "true");
    videoRef.current.muted = true;
    try {
      await videoRef.current.play();
    } catch {
      // Em alguns navegadores móveis o play bloqueia, mas o stream já está ativo.
    }
    cameraReadyRef.current = true;
    setCameraReady(true);
    setCameraBlocked(false);
    setStatus("Camera ativa");
  }

  async function startCamera() {
    setLiveCameraOn(true);
    setCameraRequested(true);
    setStatus("Preparando camera...");
    cameraReadyRef.current = false;
    setCameraReady(false);
    setCameraBlocked(false);

    const highResVideo = {
      width: { ideal: 1920, max: 3840 },
      height: { ideal: 1080, max: 2160 },
      facingMode: { ideal: "environment" as const },
    };
    const tries: MediaStreamConstraints[] = [
      { video: highResVideo, audio: false },
      {
        video: {
          ...highResVideo,
          facingMode: { exact: "environment" },
        },
        audio: false,
      },
      { video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
    ];

    for (const constraints of tries) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = stream;
        await attachStream(stream);
        const hasLiveTrack = stream.getVideoTracks().some((t) => t.readyState === "live");
        if (hasLiveTrack) {
          cameraReadyRef.current = true;
          setCameraReady(true);
          setCameraBlocked(false);
          setStatus("Camera ativa");
        }
        return;
      } catch {
        // Tenta a proxima estrategia.
      }
    }

    setCameraReady(false);
    cameraReadyRef.current = false;
    setCameraBlocked(true);
    setStatus("Camera indisponivel");
  }

  useEffect(() => {
    const id = getOrCreateDeviceId();
    setDeviceId(id);
    void loadScans(id);

    return () => {
      if (prepTimeoutRef.current) window.clearTimeout(prepTimeoutRef.current);
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, [loadScans]);

  useEffect(() => {
    const key = "sentinela_v1_app_version";
    const previous = localStorage.getItem(key);
    if (previous && previous !== appVersion) {
      setShowUpdateBanner(true);
    }
    localStorage.setItem(key, appVersion);
  }, [appVersion]);

  useEffect(() => {
    try {
      const m = localStorage.getItem(LS_USAGE_MODE);
      if (m === "familia" || m === "mei") {
        setUsageMode(m);
      } else {
        setShowUsageModal(true);
      }
      setMonthlyIncome(readMonthlyIncomeFromStorage());
      setGoals(readGoalsFromStorage());
      const cush = localStorage.getItem(LS_SPEND_CUSHION);
      if (cush) {
        const n = Number.parseFloat(cush);
        if (Number.isFinite(n) && n >= 0) setSpendCushion(n);
      }
      setFixedExpenses(readFixedFromStorage());
      const rem = localStorage.getItem(LS_REMINDER_DUE);
      setReminderDueEnabled(rem === "1" || rem === "true");
    } catch {
      setShowUsageModal(true);
    }
  }, []);

  useEffect(() => {
    if (!liveCameraOn) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
      cameraReadyRef.current = true;
      setCameraReady(true);
      setCameraBlocked(false);
    }
  }, [liveCameraOn]);

  useEffect(() => {
    if (!pdfWaitOverlay || pdfEtaSec <= 0) return;
    const t = window.setInterval(() => {
      setPdfEtaSec((s) => (s <= 1 ? 0 : s - 1));
    }, 1000);
    return () => window.clearInterval(t);
  }, [pdfWaitOverlay, pdfEtaSec]);

  useEffect(() => {
    if (!reminderDueEnabled) return;
    const run = () => {
      notifyUpcomingDues(scans);
    };
    run();
    const intervalId = window.setInterval(run, 30 * 60 * 1000);
    const onVis = () => {
      if (document.visibilityState === "visible") run();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [scans, reminderDueEnabled]);

  const footerTitle = useMemo(() => {
    if (analysis?.vencimento && analysis.vencimento !== "Nao identificado") {
      return analysis.vencimento;
    }
    return nextDue;
  }, [analysis?.vencimento, nextDue]);

  async function handleNativeCaptureUpload(
    event: React.ChangeEvent<HTMLInputElement>,
  ) {
    const file = event.target.files?.[0];
    event.currentTarget.value = "";
    if (!file || isScanning) return;
    const currentDeviceId = deviceId || getOrCreateDeviceId();
    if (!currentDeviceId) {
      setStatus("Falha ao identificar dispositivo");
      setCaptureMeta((prev) => ({
        ...prev,
        captured: false,
        analyzed: false,
        saved: false,
        saveError: "device_id ausente",
      }));
      return;
    }
    if (!deviceId) setDeviceId(currentDeviceId);

    if (file.size > MAX_UPLOAD_BYTES_CLIENT) {
      setToast("Arquivo grande demais. Maximo ~12 MB.");
      setTimeout(() => setToast(null), 3500);
      return;
    }

    setIsScanning(true);
    const isPdf = isPdfFile(file);
    setStatus(isPdf ? "Lendo PDF..." : "Processando foto...");
    setCaptureMeta({
      capturedAt: new Date().toLocaleString("pt-BR"),
      captured: true,
      analyzed: false,
      saved: false,
      persistedId: null,
      saveError: null,
    });

    setPdfPageCountOverlay(null);
    if (isPdf) {
      try {
        const pages = await getPdfPageCount(file);
        setPdfPageCountOverlay(pages);
        const est = Math.max(30, pages * PDF_SEC_PER_PAGE_EST);
        setPdfEtaSec(est);
        setPdfWaitOverlay(true);
        setStatus(
          pages >= 3
            ? `PDF com ${pages} paginas — lendo uma por vez na nuvem...`
            : `Analisando PDF (${pages} pag.)...`,
        );
      } catch {
        setPdfPageCountOverlay(null);
        setPdfWaitOverlay(true);
        setPdfEtaSec(90);
        setStatus("PDF grande — aguarde, leitura pagina a pagina...");
      }
    }

    try {
      const detectedCodes = isPdf ? [] : await detectCodesFromFile(file);
      setLastDetectedCodes(detectedCodes);
      const qrText = detectedCodes.length > 0 ? detectedCodes.join("\n") : null;
      const { imageBase64, mimeType } = await readFileAsAnalyzePayload(file);

      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageBase64,
          mimeType,
          deviceId: currentDeviceId,
          qrText,
        }),
      });

      let data: AnalyzeResponse;
      try {
        data = (await response.json()) as AnalyzeResponse;
      } catch {
        data = {
          categoria: "financeira",
          titulo: "",
          valor: "",
          vencimento: "",
          imposto_estimado: "",
          error: "Resposta invalida da API",
        };
      }
      if (response.status === 402 || data.requiresUpgrade) {
        setShowUpgrade(true);
        setStatus("Limite gratuito atingido");
        setCaptureMeta((prev) => ({
          ...prev,
          analyzed: true,
          saved: false,
          saveError: data.error ?? "Limite gratuito atingido",
        }));
        return;
      }
      if (response.status === 413) {
        setToast(data.details ?? data.error ?? "Arquivo grande demais.");
        setTimeout(() => setToast(null), 4000);
        setStatus("Arquivo recusado");
        setCaptureMeta((prev) => ({
          ...prev,
          analyzed: false,
          saved: false,
          saveError: data.error ?? "413",
        }));
        return;
      }
      if (!response.ok) {
        setStatus(data.error ?? "Falha na analise");
        setCaptureMeta((prev) => ({
          ...prev,
          analyzed: true,
          saved: false,
          saveError:
            data.details ??
            data.error ??
            data.persistenceError ??
            `Falha na analise (HTTP ${response.status})`,
        }));
        return;
      }
      if (data.status === "QUALIDADE_INSUFICIENTE") {
        setToast(
          isPdf
            ? "Nao consegui ler bem o PDF. Tente outro arquivo ou foto por pagina."
            : "A foto ainda ficou ruim. Tente mais luz e enquadre o documento inteiro.",
        );
        setStatus("Qualidade insuficiente");
        setCaptureMeta((prev) => ({
          ...prev,
          analyzed: true,
          saved: false,
          saveError: "Qualidade insuficiente para leitura",
        }));
        setTimeout(() => setToast(null), 3500);
        return;
      }

      setAnalysis(data);
      setLastPersistedId(data.persistedId ?? null);
      setCaptureMeta((prev) => ({
        ...prev,
        analyzed: true,
        saved: Boolean(data.persisted),
        persistedId: data.persistedId ?? null,
        saveError: data.persistenceError ?? null,
      }));
      setActiveTab("contas");
      if (isPdf && typeof data.analyzedPages === "number") {
        setToast(
          `Tudo certo — ${data.analyzedPages} pagina(s) no seu painel. Sua vida financeira fica mais organizada por aqui.`,
        );
        setTimeout(() => setToast(null), 4000);
      } else if (detectedCodes.length > 0) {
        setToast("Codigo/QR detectado e anexado na analise.");
        setTimeout(() => setToast(null), 2000);
      }
      setDrawerOpen(true);
      setSuccessPulse(true);
      setTimeout(() => setSuccessPulse(false), 1200);
      if (data.vencimento && data.vencimento !== "Nao identificado") {
        setNextDue(data.vencimento);
      }
      await loadScans(currentDeviceId);
      setStatus("Analise concluida");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erro de rede ou arquivo";
      setStatus("Erro ao processar");
      setCaptureMeta((prev) => ({
        ...prev,
        analyzed: false,
        saved: false,
        saveError: msg,
      }));
    } finally {
      setIsScanning(false);
      setPdfWaitOverlay(false);
      setPdfEtaSec(0);
      setPdfPageCountOverlay(null);
    }
  }

  const financeScans = scans.filter((s) => s.categoria === "financeira");

  const sortedFinanceScans = useMemo(() => {
    return [...financeScans].sort((a, b) => {
      const aDate = parseVencimentoDate(a.vencimento);
      const bDate = parseVencimentoDate(b.vencimento);
      const aPaid = isMarkedAsPaid(a);
      const bPaid = isMarkedAsPaid(b);

      if (aPaid && !bPaid) return 1;
      if (!aPaid && bPaid) return -1;
      if (!aDate && bDate) return 1;
      if (aDate && !bDate) return -1;
      if (!aDate && !bDate) return 0;

      const now = new Date().getTime();
      const aDiff = Math.abs(aDate!.getTime() - now);
      const bDiff = Math.abs(bDate!.getTime() - now);
      return aDiff - bDiff;
    });
  }, [financeScans]);

  const filteredFinanceScans = useMemo(() => {
    let base = sortedFinanceScans;
    if (onlyRisk) base = base.filter((item) => isFinanceRisk(item));
    if (financeFilter === "tudo") return base;
    if (financeFilter === "pagos") {
      return base.filter((item) => isMarkedAsPaid(item));
    }
    const now = new Date();
    return base.filter((item) => {
      if (isMarkedAsPaid(item)) return false;
      const due = parseVencimentoDate(item.vencimento);
      if (!due) return false;
      const days = (due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
      return days >= 0 && days <= 7;
    });
  }, [financeFilter, onlyRisk, sortedFinanceScans]);

  const totalTax = useMemo(() => {
    return financeScans.reduce((acc, item) => acc + parseMoney(item.imposto_estimado), 0);
  }, [financeScans]);

  const totalGross = useMemo(() => {
    return financeScans.reduce((acc, item) => acc + parseMoney(item.valor), 0);
  }, [financeScans]);
  const totalNet = Math.max(totalGross - totalTax, 0);
  const taxPct = totalGross > 0 ? Math.min((totalTax / totalGross) * 100, 100) : 0;
  const netPct = totalGross > 0 ? Math.min((totalNet / totalGross) * 100, 100) : 0;
  const dueWeekTotal = useMemo(() => {
    const now = new Date();
    return financeScans
      .filter((scan) => !isMarkedAsPaid(scan))
      .filter((scan) => {
        const due = parseVencimentoDate(scan.vencimento);
        if (!due) return false;
        const days = (due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
        return days >= 0 && days <= 7;
      })
      .reduce((acc, scan) => acc + parseMoney(scan.valor), 0);
  }, [financeScans]);

  const openBillsTotal = useMemo(() => {
    return financeScans
      .filter((s) => !isMarkedAsPaid(s))
      .reduce((acc, s) => acc + parseMoney(s.valor), 0);
  }, [financeScans]);

  const fixedMonthlyTotal = useMemo(() => {
    return fixedExpenses.filter((f) => f.ativo).reduce((acc, f) => acc + f.valor, 0);
  }, [fixedExpenses]);

  const totalCommitted = openBillsTotal + fixedMonthlyTotal;
  const leftoverAfterCommitted = Math.max(0, monthlyIncome - totalCommitted);

  const spendAdvice = useMemo(() => {
    const n = parseMoney(spendAsk);
    if (!Number.isFinite(n) || n <= 0) return null;
    return computeSpendAdvice(n, leftoverAfterCommitted, spendCushion);
  }, [spendAsk, leftoverAfterCommitted, spendCushion]);

  const monthTimeline = useMemo(() => {
    const open = financeScans.filter((s) => !isMarkedAsPaid(s));
    const rows = open
      .map((scan) => ({ scan, due: parseVencimentoDate(scan.vencimento) }))
      .filter((x): x is { scan: ScanRecord; due: Date } => Boolean(x.due));
    rows.sort((a, b) => a.due.getTime() - b.due.getTime());
    const map = new Map<string, ScanRecord[]>();
    for (const { scan, due } of rows) {
      const label = getWeekRangeLabel(due);
      const prev = map.get(label) ?? [];
      prev.push(scan);
      map.set(label, prev);
    }
    return Array.from(map.entries());
  }, [financeScans]);

  const totalOpenBills = useMemo(
    () => financeScans.filter((s) => !isMarkedAsPaid(s)).length,
    [financeScans],
  );
  const overdueScans = useMemo(
    () => sortedFinanceScans.filter((scan) => isOverdue(scan)),
    [sortedFinanceScans],
  );
  const primaryOverdue = overdueScans[0] ?? null;
  const openFinanceScans = useMemo(
    () => sortedFinanceScans.filter((scan) => !isMarkedAsPaid(scan)),
    [sortedFinanceScans],
  );
  const actionFromAnalysis = useMemo(() => {
    if (!analysis) return null;
    const detectedSnippet = lastDetectedCodes.length > 0 ? lastDetectedCodes.join("\n") : "";
    return {
      id: lastPersistedId ?? -1,
      created_at: new Date().toISOString(),
      categoria: "financeira" as const,
      titulo: analysis.titulo || "Conta",
      valor: analysis.valor || "Nao identificado",
      vencimento: analysis.vencimento || "Nao identificado",
      imposto_estimado: analysis.imposto_estimado || "0",
      beneficiario: "",
      alerta_fraude: Boolean(analysis.alerta_fraude),
      motivo_fraude: analysis.motivo_fraude || "",
      raw_response: `${analysis.raw ?? ""}\n${detectedSnippet}`.trim(),
    } satisfies ScanRecord;
  }, [analysis, lastPersistedId, lastDetectedCodes]);
  const primaryActionScan = primaryOverdue ?? openFinanceScans[0] ?? actionFromAnalysis;

  const tabStyle = (tab: TabKey) =>
    `inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-semibold transition ${
      activeTab === tab
        ? "bg-white text-black"
        : "bg-white/10 text-white hover:bg-white/15"
    }`;

  function persistUsageMode(mode: "familia" | "mei") {
    try {
      localStorage.setItem(LS_USAGE_MODE, mode);
    } catch {
      /* ignore */
    }
    setUsageMode(mode);
    setShowUsageModal(false);
  }

  function persistMonthlyIncome(value: number) {
    const v = Number.isFinite(value) && value >= 0 ? value : 0;
    try {
      localStorage.setItem(LS_MONTHLY_INCOME, String(v));
    } catch {
      /* ignore */
    }
    setMonthlyIncome(v);
  }

  function persistGoals(next: SavingsGoal[]) {
    try {
      localStorage.setItem(LS_GOALS, JSON.stringify(next));
    } catch {
      /* ignore */
    }
    setGoals(next);
  }

  function persistSpendCushion(value: number) {
    const v = Number.isFinite(value) && value >= 0 ? value : 0;
    try {
      localStorage.setItem(LS_SPEND_CUSHION, String(v));
    } catch {
      /* ignore */
    }
    setSpendCushion(v);
  }

  function persistFixed(next: FixedExpense[]) {
    try {
      localStorage.setItem(LS_FIXED, JSON.stringify(next));
    } catch {
      /* ignore */
    }
    setFixedExpenses(next);
  }

  function addFixedExpense() {
    const nome = newFixedName.trim() || "Despesa fixa";
    const valor = parseMoney(newFixedValor);
    if (valor <= 0) {
      setToast("Informe um valor valido para o fixo.");
      setTimeout(() => setToast(null), 2500);
      return;
    }
    const dia = Number.isFinite(newFixedDia) ? Math.min(28, Math.max(1, Math.floor(newFixedDia))) : 10;
    persistFixed([
      ...fixedExpenses,
      { id: crypto.randomUUID(), nome, valor, diaVencimento: dia, ativo: true },
    ]);
    setNewFixedName("");
    setNewFixedValor("");
    setNewFixedDia(10);
  }

  async function setReminderDueOn(on: boolean) {
    if (on && typeof Notification !== "undefined" && Notification.permission === "default") {
      const p = await Notification.requestPermission();
      if (p !== "granted") {
        setToast("Sem permissao, os lembretes de vencimento ficam desligados.");
        setTimeout(() => setToast(null), 3500);
        return;
      }
    }
    if (on && typeof Notification !== "undefined" && Notification.permission === "denied") {
      setToast("Notificacoes bloqueadas no navegador. Libere nas configuracoes do site.");
      setTimeout(() => setToast(null), 4000);
      return;
    }
    try {
      localStorage.setItem(LS_REMINDER_DUE, on ? "1" : "0");
    } catch {
      /* ignore */
    }
    setReminderDueEnabled(on);
    if (on) notifyUpcomingDues(scans);
  }

  async function shareResumoCard() {
    setShareCardBusy(true);
    try {
      const canvas = document.createElement("canvas");
      const w = 1080;
      const h = 1350;
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        setToast("Nao foi possivel gerar a imagem aqui.");
        setTimeout(() => setToast(null), 3000);
        return;
      }
      const grd = ctx.createLinearGradient(0, 0, 0, h);
      grd.addColorStop(0, "#0f172a");
      grd.addColorStop(0.55, "#064e3b");
      grd.addColorStop(1, "#020617");
      ctx.fillStyle = grd;
      ctx.fillRect(0, 0, w, h);

      ctx.fillStyle = "#ecfdf5";
      ctx.font = "bold 64px system-ui, sans-serif";
      ctx.fillText("Sentinela", 72, 110);
      ctx.font = "28px system-ui, sans-serif";
      ctx.fillStyle = "#6ee7b7";
      const sub = "Menos susto no mes — sem ligar ao banco.";
      ctx.fillText(sub, 72, 175);

      ctx.fillStyle = "#f8fafc";
      ctx.font = "36px system-ui, sans-serif";
      let y = 300;
      const line = (t: string) => {
        ctx.fillText(t, 72, y);
        y += 64;
      };
      line(`${totalOpenBills} conta(s) em aberto (scans)`);
      line(`${formatBRL(dueWeekTotal)} a vencer em 7 dias`);
      line(`${formatBRL(fixedMonthlyTotal)} em despesas fixas do mes`);
      line(`Sobra estimada: ${formatBRL(leftoverAfterCommitted)}`);

      ctx.fillStyle = "#64748b";
      ctx.font = "22px system-ui, sans-serif";
      ctx.fillText("Voce envia PDF/foto; nos organizamos. Baixe o app no celular.", 72, h - 120);
      ctx.fillText(`Atualizado em ${new Date().toLocaleString("pt-BR")}`, 72, h - 78);

      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((b) => resolve(b), "image/png", 0.92),
      );
      if (!blob) {
        setToast("Falha ao exportar imagem.");
        setTimeout(() => setToast(null), 3000);
        return;
      }
      const file = new File([blob], "sentinela-resumo.png", { type: "image/png" });
      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: "Resumo Sentinela",
          text: "Meu mes organizado com o Sentinela",
        });
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "sentinela-resumo.png";
        a.click();
        URL.revokeObjectURL(url);
        setToast("Imagem baixada — envie no WhatsApp ou Stories.");
        setTimeout(() => setToast(null), 3500);
      }
    } catch {
      setToast("Nao foi possivel compartilhar agora.");
      setTimeout(() => setToast(null), 3000);
    } finally {
      setShareCardBusy(false);
    }
  }

  function addGoal() {
    const nome = newGoalName.trim() || "Meta";
    const valorAlvo = parseMoney(newGoalTarget);
    if (valorAlvo <= 0) {
      setToast("Informe um valor alvo valido.");
      setTimeout(() => setToast(null), 2500);
      return;
    }
    const id = crypto.randomUUID();
    const dataAlvo =
      newGoalDate && /^\d{4}-\d{2}-\d{2}$/.test(newGoalDate) ? newGoalDate : undefined;
    persistGoals([...goals, { id, nome, valorAlvo, valorAtual: 0, dataAlvo }]);
    setNewGoalName("");
    setNewGoalTarget("");
    setNewGoalDate("");
  }

  async function tryEnableNotifications() {
    if (!("Notification" in window)) {
      setToast("Seu navegador nao suporta avisos. Em breve: lembretes por e-mail.");
      setTimeout(() => setToast(null), 3500);
      return;
    }
    const p = await Notification.requestPermission();
    if (p === "granted") {
      setToast("Avisos ativados. Vamos usar para vencimentos em uma proxima versao.");
      setTimeout(() => setToast(null), 4000);
    } else {
      setToast("Permissao negada. Voce ainda pode usar o app normalmente.");
      setTimeout(() => setToast(null), 3000);
    }
  }

  async function handleSecondOpinion(scan: ScanRecord) {
    setSecondOpinionLoading((prev) => ({ ...prev, [scan.id]: true }));
    try {
      const res = await fetch("/api/second-opinion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rawJson: scan.raw_response ?? "",
          titulo: scan.titulo,
          valor: scan.valor,
          vencimento: scan.vencimento,
        }),
      });
      if (!res.ok) {
        setToast("Nao foi possivel obter segunda opiniao agora.");
        setTimeout(() => setToast(null), 3000);
        return;
      }
      const data = (await res.json()) as SecondOpinion;
      setSecondOpinions((prev) => ({ ...prev, [scan.id]: data }));
    } finally {
      setSecondOpinionLoading((prev) => ({ ...prev, [scan.id]: false }));
    }
  }

  async function exportReport() {
    const now = new Date();
    const upcoming = financeScans
      .filter((scan) => !isMarkedAsPaid(scan))
      .filter((scan) => {
        const due = parseVencimentoDate(scan.vencimento);
        if (!due) return false;
        const days = (due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
        return days >= 0 && days <= 7;
      })
      .slice(0, 10)
      .map((scan) => `- ${scan.titulo}: ${scan.valor} (venc. ${scan.vencimento})`);

    const text =
      `📊 Sentinela - Resumo Financeiro\n` +
      `• Impostos identificados: ${formatBRL(totalTax)}\n` +
      `• Total a vencer em 7 dias: ${formatBRL(dueWeekTotal)}\n` +
      `• Itens da semana:\n${upcoming.length ? upcoming.join("\n") : "- Nenhum vencimento na semana"}`;

    if (navigator.share) {
      try {
        await navigator.share({ text });
        return;
      } catch {
        // fallback para clipboard
      }
    }
    await navigator.clipboard.writeText(text);
    setToast("Relatorio copiado para compartilhar no WhatsApp.");
    setTimeout(() => setToast(null), 2800);
  }

  async function discardLastCapture() {
    const currentDeviceId = deviceId || getOrCreateDeviceId();
    if (!deviceId) setDeviceId(currentDeviceId);
    const targetId = lastPersistedId;
    // UX first: remove from screen immediately.
    setToast("Descartando captura...");
    setTimeout(() => setToast(null), 1200);
    setAnalysis(null);
    setLastPersistedId(null);
    setCaptureMeta((prev) => ({
      ...prev,
      saved: false,
      persistedId: null,
      saveError: null,
    }));
    if (targetId) {
      setScans((prev) => prev.filter((s) => s.id !== targetId));
    }
    setLastDetectedCodes([]);

    if (!supabase || !targetId) {
      setStatus("Captura descartada localmente");
      setToast("Captura descartada na tela.");
      setTimeout(() => setToast(null), 2200);
      return;
    }

    try {
      const { data: removedRow, error } = await supabase
        .from("sentinela_scans")
        .delete()
        .eq("id", targetId)
        .eq("device_id", currentDeviceId)
        .select("id")
        .maybeSingle();

      if (error || !removedRow) {
        const hardDelete = await supabase
          .from("sentinela_scans")
          .delete()
          .eq("id", targetId)
          .select("id")
          .maybeSingle();
        if (hardDelete.data) {
          await loadScans(currentDeviceId);
          setStatus("Captura descartada");
          setToast("Captura removida com sucesso.");
          setTimeout(() => setToast(null), 2200);
          return;
        }
        const titleDiscarded = encryptText("DESCARTADO - captura", false);
        const { error: fallbackError } = await supabase
          .from("sentinela_scans")
          .update({ titulo: titleDiscarded })
          .eq("id", targetId);
        if (fallbackError) {
          setToast("Descartada na tela, mas falhou ao remover no banco.");
          setTimeout(() => setToast(null), 3000);
          return;
        }
      }

      await loadScans(currentDeviceId);
      setStatus("Captura descartada");
      setToast("Captura removida com sucesso.");
      setTimeout(() => setToast(null), 2200);
    } catch {
      setToast("Descartada na tela, mas falhou no banco.");
      setTimeout(() => setToast(null), 3000);
    }
  }

  function sendToWhatsapp() {
    const now = new Date();
    const upcoming = financeScans
      .filter((scan) => !isMarkedAsPaid(scan))
      .filter((scan) => {
        const due = parseVencimentoDate(scan.vencimento);
        if (!due) return false;
        const days = (due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
        return days >= 0 && days <= 7;
      })
      .slice(0, 10)
      .map((scan) => `- ${scan.titulo}: ${scan.valor} (venc. ${scan.vencimento})`);

    const text =
      `📊 Sentinela - Resumo Financeiro\n` +
      `• Impostos identificados: ${formatBRL(totalTax)}\n` +
      `• Total a vencer em 7 dias: ${formatBRL(dueWeekTotal)}\n` +
      `• Itens da semana:\n${upcoming.length ? upcoming.join("\n") : "- Nenhum vencimento na semana"}`;

    const encoded = encodeURIComponent(text);
    window.open(`https://wa.me/?text=${encoded}`, "_blank", "noopener,noreferrer");
  }

  async function refreshToLatestVersion() {
    try {
      if ("caches" in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
    } catch {
      // If cache API fails, still proceed with force reload below.
    }
    const u = new URL(window.location.href);
    u.searchParams.set("v", appVersion);
    u.searchParams.set("r", String(Date.now()));
    window.location.href = u.toString();
  }

  async function handlePayNow(scan: ScanRecord) {
    const fromScan = extractPaymentData(scan);
    const fromDetectedCodes = lastDetectedCodes
      .map((item) => ({
        code: extractBoletoCodeFromText(item),
        paymentUrl: extractPaymentUrlFromText(item),
        source: item,
      }))
      .find((item) => item.code || item.paymentUrl || item.source.length >= 30);
    const resolved = fromScan.code || fromScan.paymentUrl ? fromScan : fromDetectedCodes;
    const formatted = resolved?.code ? resolved.code.replace(/\D/g, "") : "";
    const paymentUrl = resolved?.paymentUrl ?? null;
    const paymentPayload = !formatted && !paymentUrl ? (resolved?.source || "").trim() : "";
    try {
      if (paymentUrl) {
        window.open(paymentUrl, "_blank", "noopener,noreferrer");
      }
      if (formatted) {
        await navigator.clipboard.writeText(formatted);
        setToast("Linha digitavel/codigo de barras copiado.");
        setTimeout(() => setToast(null), 3000);
        return;
      }
      if (paymentPayload && paymentPayload.length >= 30) {
        await navigator.clipboard.writeText(paymentPayload);
        setToast("Payload do QR Pix copiado para pagamento.");
        setTimeout(() => setToast(null), 3000);
        return;
      }
      if (paymentUrl && navigator.share) {
        await navigator.share({
          title: "Pagamento de boleto",
          text: "Link de pagamento detectado.",
          url: paymentUrl,
        });
        return;
      }
      setToast("Nao encontrei codigo de barras nem QR de pagamento. Recapture focando o codigo.");
      setTimeout(() => setToast(null), 3500);
    } catch {
      try {
        if (paymentUrl) {
          await navigator.clipboard.writeText(paymentUrl);
          setToast("Link de pagamento copiado.");
          setTimeout(() => setToast(null), 2800);
          return;
        }
        if (paymentPayload) {
          await navigator.clipboard.writeText(paymentPayload);
          setToast("Payload de pagamento copiado.");
          setTimeout(() => setToast(null), 2800);
          return;
        }
      } catch {
        setTimeout(() => setToast(null), 2800);
      }
      setToast("Nao consegui extrair um codigo de pagamento valido.");
      setTimeout(() => setToast(null), 2500);
    }
  }

  async function handleMarkAsPaid(scan: ScanRecord) {
    if (!supabase || !deviceId || overdueActionBusy) return;
    setOverdueActionBusy(true);
    const paidTitle = isMarkedAsPaid(scan) ? scan.titulo : `PAGO - ${scan.titulo}`;
    const paidTitleEncrypted = encryptText(paidTitle, false);
    try {
      const updateTry = await supabase
        .from("sentinela_scans")
        .update({ titulo: paidTitleEncrypted })
        .eq("id", scan.id)
        .eq("device_id", deviceId);

      if (updateTry.error) {
        const del = await supabase
          .from("sentinela_scans")
          .delete()
          .eq("id", scan.id)
          .eq("device_id", deviceId);
        if (del.error) throw del.error;
        const ins = await supabase.from("sentinela_scans").insert({
          device_id: deviceId,
          categoria: "financeira",
          titulo: paidTitleEncrypted,
          valor: scan.valor,
          vencimento: scan.vencimento,
          imposto_estimado: scan.imposto_estimado,
          beneficiario: encryptText(scan.beneficiario ?? "", false),
          alerta_fraude: scan.alerta_fraude ?? false,
          motivo_fraude: encryptText(scan.motivo_fraude ?? "", false),
          raw_response: scan.raw_response ?? "",
        });
        if (ins.error) throw ins.error;
      }

      await loadScans(deviceId);
      setOverdueModalOpen(false);
      setToast("Conta marcada como paga.");
      setTimeout(() => setToast(null), 2500);
    } catch (e) {
      setToast(`Falha ao marcar como paga: ${String(e)}`);
      setTimeout(() => setToast(null), 3500);
    } finally {
      setOverdueActionBusy(false);
    }
  }

  return (
    <main
      className={`relative h-dvh w-full overflow-hidden text-white ${
        liveCameraOn ? "bg-black" : "bg-gradient-to-br from-slate-950 via-emerald-950/80 to-black"
      }`}
    >
      <video
        ref={videoRef}
        className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-300 ${
          liveCameraOn ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        muted
        playsInline
        autoPlay
        onLoadedMetadata={() => {
          cameraReadyRef.current = true;
          setCameraReady(true);
          setCameraBlocked(false);
          setStatus("Camera ativa");
        }}
      />
      <div
        className={`absolute inset-0 bg-gradient-to-b from-black/35 via-transparent to-black/50 ${
          liveCameraOn ? "" : "opacity-60"
        }`}
      />

      {liveCameraOn && !cameraReady && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/65">
          <div className="w-[min(92vw,360px)] rounded-2xl border border-white/20 bg-black/70 p-5 text-center backdrop-blur">
            <p className="text-sm text-zinc-200">
              {!cameraRequested
                ? "Toque para autorizar a camera no navegador."
                : cameraBlocked
                  ? "Nao conseguimos abrir a camera. Verifique a permissao no navegador."
                  : "Preparando camera..."}
            </p>
            <button
              onClick={() => {
                void startCamera();
                if (prepTimeoutRef.current) window.clearTimeout(prepTimeoutRef.current);
                prepTimeoutRef.current = window.setTimeout(() => {
                  setCameraBlocked((prev) => prev || !cameraReadyRef.current);
                }, 5000);
              }}
              className="mt-4 w-full rounded-xl bg-white py-2.5 text-sm font-semibold text-black"
            >
              Ativar camera
            </button>
          </div>
        </div>
      )}

      <div className="absolute left-1/2 top-6 -translate-x-1/2 rounded-full bg-black/40 px-4 py-1.5 text-xs font-medium backdrop-blur">
        {status}
      </div>

      {showUpdateBanner && (
        <div className="absolute left-1/2 top-14 z-50 w-[min(94vw,460px)] -translate-x-1/2 rounded-xl border border-emerald-300/40 bg-black/75 px-3 py-2 text-xs text-emerald-100 shadow-xl backdrop-blur">
          <div className="flex items-center justify-between gap-2">
            <span>Nova versao disponivel. Toque para atualizar.</span>
            <button
              onClick={() => {
                void refreshToLatestVersion();
              }}
              className="rounded-md border border-emerald-200/50 bg-emerald-500/20 px-2 py-1 font-semibold hover:bg-emerald-500/30"
            >
              Atualizar agora
            </button>
          </div>
        </div>
      )}

      {!isScanning && (
        <div
          className={`absolute right-4 z-30 w-[min(92vw,300px)] rounded-2xl border border-emerald-200/20 bg-black/45 p-3 text-xs backdrop-blur ${
            showUpdateBanner ? "top-32 sm:top-28" : "top-6"
          }`}
        >
          <p className="font-semibold text-zinc-200">Sua semana em ordem</p>
          <p className="mt-1">
            📋 {totalOpenBills} conta(s) em aberto
          </p>
          <p className="mt-1">
            💰 {formatBRL(dueWeekTotal)} a vencer em 7 dias
          </p>
          {usageMode && (
            <p className="mt-1 text-emerald-200/90">
              Modo: {usageMode === "mei" ? "MEI / negocio" : "Familia"}
            </p>
          )}
          {primaryActionScan && (
            <button
              onClick={() => setOverdueModalOpen(true)}
              className={`mt-2 rounded-md px-2 py-1 text-left text-[11px] font-semibold ${
                overdueScans.length > 0
                  ? "border border-red-300/40 bg-red-500/20 text-red-100"
                  : "border border-amber-300/40 bg-amber-500/20 text-amber-100"
              }`}
            >
              {overdueScans.length > 0
                ? `🔴 Conta vencida (${overdueScans.length}) - toque para acoes`
                : `💳 Conta para pagar - toque para acoes`}
            </button>
          )}
        </div>
      )}

      {toast && (
        <div className="absolute left-1/2 top-16 z-40 w-[min(92vw,420px)] -translate-x-1/2 rounded-xl border border-amber-300/50 bg-black/75 px-4 py-2 text-sm text-amber-200 shadow-xl backdrop-blur">
          {toast}
        </div>
      )}

      {pdfWaitOverlay && (
        <div className="absolute inset-0 z-[48] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl border border-emerald-300/35 bg-zinc-900/95 p-5 text-center shadow-xl">
            <p className="text-base font-semibold text-emerald-100">
              {pdfPageCountOverlay != null && pdfPageCountOverlay >= 3
                ? "Muitas paginas — aguarde um momento"
                : "Lendo seu PDF"}
            </p>
            <p className="mt-2 text-xs leading-relaxed text-zinc-300">
              O servidor separa o arquivo em paginas e envia uma de cada vez para a IA. Assim extratos
              grandes nao estouram limite nem dao erro no meio.
            </p>
            {pdfPageCountOverlay != null && (
              <p className="mt-2 text-sm font-medium text-white">
                {pdfPageCountOverlay} pagina{pdfPageCountOverlay === 1 ? "" : "s"} detectada
                {pdfPageCountOverlay === 1 ? "" : "s"}
              </p>
            )}
            <div className="mt-4 rounded-xl border border-white/10 bg-black/40 py-4">
              <p className="text-[10px] uppercase tracking-wider text-zinc-500">Tempo restante (estim.)</p>
              <p className="mt-1 font-mono text-3xl font-bold tabular-nums text-emerald-300">
                {formatCountdown(pdfEtaSec)}
              </p>
              {pdfEtaSec <= 0 && (
                <p className="mt-2 px-2 text-[11px] text-amber-200/90">
                  Contagem zerou — ainda estamos processando. Nao feche a aba.
                </p>
              )}
            </div>
            <p className="mt-3 text-[11px] text-zinc-500">Dica: PDFs muito pesados podem levar mais tempo.</p>
          </div>
        </div>
      )}

      <input
        ref={nativeCaptureRef}
        type="file"
        accept="image/*,application/pdf,.pdf"
        className="hidden"
        onChange={(event) => {
          void handleNativeCaptureUpload(event);
        }}
      />
      <div className="absolute left-1/2 top-24 z-40 w-[min(94vw,520px)] -translate-x-1/2 text-center">
        <p className="text-lg font-bold tracking-tight text-white drop-shadow-md">Sentinela</p>
        <p className="mt-1 text-sm leading-relaxed text-zinc-300">
          Menos susto no mês: boletos, faturas e extratos num só lugar. Não prometemos riqueza —
          prometemos clareza para você planear, no seu ritmo.
        </p>
      </div>

      <div className="absolute left-1/2 top-40 z-40 flex w-[min(94vw,520px)] -translate-x-1/2 flex-col gap-2 sm:flex-row sm:items-stretch">
        <button
          type="button"
          onClick={() => nativeCaptureRef.current?.click()}
          disabled={isScanning}
          className="flex-1 rounded-xl border border-emerald-200/50 bg-emerald-500/30 px-4 py-3 text-sm font-semibold text-emerald-50 shadow-xl backdrop-blur transition hover:bg-emerald-500/40 disabled:opacity-60"
        >
          {isScanning ? "Processando..." : "Anexar foto ou PDF"}
        </button>
        <div className="flex gap-2 sm:w-auto">
          {!liveCameraOn ? (
            <button
              type="button"
              onClick={() => {
                void startCamera();
                if (prepTimeoutRef.current) window.clearTimeout(prepTimeoutRef.current);
                prepTimeoutRef.current = window.setTimeout(() => {
                  setCameraBlocked((prev) => prev || !cameraReadyRef.current);
                }, 5000);
              }}
              disabled={isScanning}
              className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl border border-white/20 bg-white/10 px-4 py-3 text-sm font-semibold text-white backdrop-blur disabled:opacity-60 sm:flex-none"
            >
              <Camera size={18} />
              Camera
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setLiveCameraOn(false)}
              className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl border border-white/20 bg-white/10 px-4 py-3 text-sm font-semibold text-white backdrop-blur sm:flex-none"
            >
              <X size={18} />
              Fechar camera
            </button>
          )}
        </div>
      </div>

      <div className="absolute left-1/2 top-[12.5rem] z-40 w-[min(94vw,520px)] -translate-x-1/2 px-1">
        <p className="flex items-start justify-center gap-2 text-center text-xs leading-snug text-emerald-100/90">
          <Shield className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" aria-hidden />
          <span>
            <strong className="font-semibold text-emerald-50">Privacidade:</strong> campos sensíveis são
            encriptados antes de guardar. Ligação HTTPS. O Sentinela{" "}
            <span className="whitespace-nowrap">não liga</span> à sua conta bancária.
          </span>
        </p>
      </div>

      <div className="absolute left-1/2 top-[16.25rem] z-40 flex w-[min(94vw,470px)] -translate-x-1/2 items-center gap-2 sm:top-[15.75rem]">
        <button
          type="button"
          onClick={() => {
            if (primaryActionScan) setOverdueModalOpen(true);
          }}
          disabled={!primaryActionScan}
          className="w-full rounded-xl border border-blue-200/20 bg-[#001f3f]/75 p-3 text-left backdrop-blur disabled:opacity-60 sm:w-[220px]"
        >
          <p className="text-[10px] uppercase tracking-wide text-blue-100/80">
            Proximo vencimento
          </p>
          <p className="text-base font-semibold">{footerTitle || "Nenhum"}</p>
          <p className="mt-1 text-[10px] text-blue-100/75">
            {primaryActionScan ? "Pagar ou marcar paga" : "Sem conta para acao"}
          </p>
        </button>
      </div>

      {overdueModalOpen && primaryActionScan && (
        <div className="absolute inset-0 z-50 flex items-end justify-center bg-black/55 p-3">
          <div className="w-full max-w-md rounded-2xl border border-white/20 bg-zinc-900/95 p-4">
            <p className="text-sm font-semibold text-red-200">
              {isOverdue(primaryActionScan) ? "Conta vencida" : "Conta para pagar"}
            </p>
            <p className="mt-1 text-sm text-zinc-100">{primaryActionScan.titulo}</p>
            <p className="mt-1 text-xs text-zinc-300">
              Valor: {primaryActionScan.valor} | Vencimento: {primaryActionScan.vencimento}
            </p>
            <p className="mt-2 text-xs text-zinc-300">
              {isOverdue(primaryActionScan)
                ? "Esta conta esta vencida. Voce pode pagar agora com o codigo do boleto, ou marcar como paga para entrar no relatorio futuro."
                : "Esta conta esta para vencer. Voce pode pagar agora com o codigo do boleto, ou marcar como paga para entrar no relatorio futuro."}
            </p>
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => {
                  void handlePayNow(primaryActionScan);
                }}
                className="flex-1 rounded-xl bg-emerald-600 px-3 py-2 text-sm font-semibold text-white"
              >
                Pagar agora
              </button>
              <button
                onClick={() => {
                  void handleMarkAsPaid(primaryActionScan);
                }}
                disabled={overdueActionBusy}
                className="flex-1 rounded-xl bg-blue-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                {overdueActionBusy ? "Salvando..." : "Marcar como paga"}
              </button>
            </div>
            <button
              onClick={() => setOverdueModalOpen(false)}
              className="mt-2 w-full rounded-xl border border-white/20 px-3 py-2 text-xs text-zinc-200"
            >
              Fechar
            </button>
          </div>
        </div>
      )}

      <section
        className={`absolute bottom-0 left-0 right-0 z-20 rounded-t-3xl border-t border-white/15 bg-zinc-950/92 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur-xl transition-all duration-300 ${
          drawerOpen ? "h-[min(56vh,calc(100dvh-9rem))]" : "h-[18vh]"
        } ${drawerOpen ? "overflow-y-auto" : "overflow-hidden"}`}
      >
        <div className="mx-auto flex min-h-0 w-[min(980px,98vw)] flex-col transition-all duration-300 ease-out">
          <div className="mb-2 flex justify-center">
            <button
              onClick={() => setDrawerOpen((v) => !v)}
              className="inline-flex items-center gap-1 rounded-full border border-white/20 bg-white/10 px-3 py-1 text-[11px] font-semibold text-zinc-100"
            >
              {drawerOpen ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
              {drawerOpen ? "Fechar gaveta" : "Puxar para cima"}
            </button>
          </div>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="flex max-w-full flex-nowrap items-center gap-2 overflow-x-auto">
              <button
                type="button"
                onClick={() => setActiveTab("contas")}
                className={tabStyle("contas")}
              >
                <Wallet size={15} />
                Contas a pagar
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("organizador")}
                className={tabStyle("organizador")}
              >
                <LayoutGrid size={15} />
                Organizador
              </button>
            </div>
            {drawerOpen && (
              <div className={`text-xs leading-snug ${successPulse ? "text-emerald-300" : "text-zinc-400"}`}>
                {successPulse
                  ? "Mais um passo: a sua lista ficou mais clara."
                  : "Contas ou organizador — o que precisa agora?"}
              </div>
            )}
          </div>

          <div className="mb-3 rounded-xl border border-emerald-300/20 bg-emerald-900/20 px-3 py-2 text-xs text-emerald-100">
            <div className="flex items-center gap-2 font-semibold">
              <Database size={13} />
              Ultima captura — vira linha no seu painel
            </div>
            {analysis && (
              <div className="mt-2 rounded-lg border border-white/15 bg-black/30 p-2 text-[11px] text-zinc-100">
                <p className="font-semibold uppercase">{analysis.categoria}</p>
                <p className="mt-0.5">{analysis.titulo}</p>
                <p className="text-zinc-300">Valor: {analysis.valor} | Imposto: {analysis.imposto_estimado}</p>
                {typeof analysis.analyzedPages === "number" && analysis.analyzedPages > 0 && (
                  <p className="mt-1 text-[11px] text-emerald-200/90">
                    PDF: {analysis.analyzedPages} pagina(s) analisada(s)
                  </p>
                )}
                {lastPersistedId && (
                  <button
                    onClick={() => void discardLastCapture()}
                    className="mt-1 rounded-md border border-red-300/40 bg-red-500/20 px-2 py-1 text-[11px] font-semibold text-red-100 hover:bg-red-500/30"
                  >
                    Descartar esta captura
                  </button>
                )}
              </div>
            )}
            <p className="mt-1">
              Capturada: {captureMeta.captured ? "sim" : "nao"} | Analisada:{" "}
              {captureMeta.analyzed ? "sim" : "nao"} | Salva: {captureMeta.saved ? "sim" : "nao"}
            </p>
          {captureMeta.saveError && (
            <p className="mt-1 text-[11px] text-amber-200">
              Motivo: {captureMeta.saveError}
            </p>
          )}
            <p className="mt-1 text-[11px] text-emerald-200/90">
              Tudo fica no seu historico abaixo — e uma base para decidir sem susto.
            </p>
          </div>

          {drawerOpen && activeTab === "contas" && (
            <>
              <div className="mb-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                <div className="rounded-xl border border-blue-300/20 bg-[#001f3f] px-4 py-3">
                  <p className="text-xs uppercase tracking-wide text-blue-100/80">
                    Total de Impostos Identificados
                  </p>
                  <p className="text-lg font-semibold">{formatBRL(totalTax)}</p>
                </div>
                <div className="rounded-xl border border-white/15 bg-white/5 px-4 py-3">
                  <p className="text-xs uppercase tracking-wide text-zinc-300">
                    Gastos x Impostos
                  </p>
                  <div className="mt-2 space-y-2">
                    <div>
                      <div className="mb-1 flex justify-between text-xs text-zinc-300">
                        <span>Valor Liquido</span>
                        <span>{formatBRL(totalNet)}</span>
                      </div>
                      <div className="h-2 rounded-full bg-zinc-800">
                        <div
                          className="h-2 rounded-full bg-emerald-400 transition-all duration-500"
                          style={{ width: `${netPct}%` }}
                        />
                      </div>
                    </div>
                    <div>
                      <div className="mb-1 flex justify-between text-xs text-zinc-300">
                        <span>Impostos Pagos</span>
                        <span>{formatBRL(totalTax)}</span>
                      </div>
                      <div className="h-2 rounded-full bg-zinc-800">
                        <div
                          className="h-2 rounded-full bg-sky-400 transition-all duration-500"
                          style={{ width: `${taxPct}%` }}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="mb-3 flex flex-wrap gap-2">
                <button
                  onClick={() => setFinanceFilter("tudo")}
                  className={`rounded-full px-3 py-1 text-xs font-semibold ${
                    financeFilter === "tudo"
                      ? "bg-white text-black"
                      : "bg-white/10 text-zinc-200"
                  }`}
                >
                  Tudo
                </button>
                <button
                  onClick={() => setFinanceFilter("vencendo7")}
                  className={`rounded-full px-3 py-1 text-xs font-semibold ${
                    financeFilter === "vencendo7"
                      ? "bg-white text-black"
                      : "bg-white/10 text-zinc-200"
                  }`}
                >
                  Vencendo em 7 dias
                </button>
                <button
                  onClick={() => setFinanceFilter("pagos")}
                  className={`rounded-full px-3 py-1 text-xs font-semibold ${
                    financeFilter === "pagos"
                      ? "bg-white text-black"
                      : "bg-white/10 text-zinc-200"
                  }`}
                >
                  Pagos
                </button>
                <label className="ml-auto inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-zinc-100">
                  <ShieldAlert size={14} className={onlyRisk ? "text-red-300" : ""} />
                  Filtrar Riscos
                  <button
                    type="button"
                    onClick={() => setOnlyRisk((v) => !v)}
                    className={`relative h-5 w-10 rounded-full transition ${
                      onlyRisk ? "bg-red-500/60" : "bg-zinc-700"
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition ${
                        onlyRisk ? "left-[22px]" : "left-0.5"
                      }`}
                    />
                  </button>
                </label>
                <button
                  onClick={() => void exportReport()}
                  className="inline-flex items-center gap-1 rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-zinc-100 hover:bg-white/15"
                >
                  <Download size={13} />
                  Exportar Relatorio
                </button>
                <button
                  type="button"
                  onClick={() => void shareResumoCard()}
                  disabled={shareCardBusy}
                  className="inline-flex items-center gap-1 rounded-full bg-fuchsia-500/25 px-3 py-1 text-xs font-semibold text-fuchsia-100 hover:bg-fuchsia-500/35 disabled:opacity-50"
                >
                  <Share2 size={13} />
                  {shareCardBusy ? "Gerando..." : "Card para compartilhar"}
                </button>
                <button
                  onClick={sendToWhatsapp}
                  className="inline-flex items-center gap-1 rounded-full bg-emerald-500/20 px-3 py-1 text-xs font-semibold text-emerald-100 hover:bg-emerald-500/30"
                >
                  Enviar para Contador (Zap)
                </button>
              </div>

              {monthTimeline.length > 0 && (
                <div className="mb-3 rounded-xl border border-sky-400/25 bg-sky-950/40 p-3">
                  <p className="flex items-center gap-2 text-xs font-semibold text-sky-100">
                    <CalendarRange size={14} />
                    Seu mes em linha do tempo (por semana)
                  </p>
                  <p className="mt-1 text-[11px] text-zinc-400">
                    So contas em aberto com vencimento identificado. Ajuda a ver o mes inteiro de uma vez.
                  </p>
                  <ul className="mt-2 space-y-2">
                    {monthTimeline.map(([label, items]) => (
                      <li key={label} className="rounded-lg border border-white/10 bg-black/25 p-2 text-[11px]">
                        <p className="font-semibold text-sky-200/95">{label}</p>
                        <ul className="mt-1 space-y-1 text-zinc-300">
                          {items.map((s) => (
                            <li key={s.id} className="flex justify-between gap-2">
                              <span className="truncate">{s.titulo}</span>
                              <span className="shrink-0 text-zinc-400">{s.vencimento}</span>
                            </li>
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="space-y-2 overflow-auto pr-1">
                {filteredFinanceScans.length === 0 && (
                  <div className="rounded-xl border border-white/10 bg-white/5 p-3 text-sm leading-relaxed text-zinc-300">
                    Nada aqui ainda — e normal. Anexe um boleto ou fatura: em segundos voce ganha uma
                    linha clara no painel e deixa de depender da cabeca para lembrar vencimento.
                  </div>
                )}
                {filteredFinanceScans.map((item) => (
                  <article
                    key={item.id}
                    className={`rounded-xl border bg-white/5 p-3 text-sm transition ${
                      isFinanceRisk(item)
                        ? "border-red-400/60 animate-pulse"
                        : "border-white/10"
                    }`}
                  >
                    <p className="font-semibold">{item.titulo}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-zinc-300">
                      <span
                        className={`rounded-md px-2 py-1 ${
                          isDueSoon(item.vencimento)
                            ? "bg-amber-500/25 text-amber-200"
                            : "bg-white/10 text-zinc-200"
                        }`}
                      >
                        Vencimento: {item.vencimento}
                      </span>
                      <span className="rounded-md bg-white/10 px-2 py-1">
                        Valor: {item.valor}
                      </span>
                      <span className="rounded-md bg-white/10 px-2 py-1">
                        Imposto: {item.imposto_estimado}
                      </span>
                      <span
                        className={`rounded-md px-2 py-1 font-semibold ${
                          isFinanceRisk(item)
                            ? "bg-red-500/25 text-red-200"
                            : "bg-emerald-500/25 text-emerald-200"
                        }`}
                      >
                        {isFinanceRisk(item) ? "Risco de Fraude" : "Seguro"}
                      </span>
                    </div>
                    <div className="mt-2">
                      <button
                        onClick={() => void handleSecondOpinion(item)}
                        disabled={Boolean(secondOpinionLoading[item.id])}
                        className="rounded-md border border-white/15 bg-white/10 px-2.5 py-1 text-xs font-medium text-zinc-100 hover:bg-white/15 disabled:opacity-60"
                      >
                        {secondOpinionLoading[item.id]
                          ? "Revisando..."
                          : "Revisar com GPT-4o"}
                      </button>
                    </div>
                    {secondOpinions[item.id] && (
                      <div className="mt-2 rounded-lg border border-white/10 bg-black/30 p-2 text-xs text-zinc-200">
                        <p className="font-semibold">
                          Segunda opiniao: {secondOpinions[item.id].nivel_risco}
                        </p>
                        <p className="mt-1">{secondOpinions[item.id].resumo_executivo}</p>
                        {secondOpinions[item.id].taxas_suspeitas.length > 0 && (
                          <p className="mt-1 text-amber-200">
                            Taxas suspeitas:{" "}
                            {secondOpinions[item.id].taxas_suspeitas.join(", ")}
                          </p>
                        )}
                        {secondOpinions[item.id].letras_miudas.length > 0 && (
                          <p className="mt-1 text-orange-200">
                            Letras miudas:{" "}
                            {secondOpinions[item.id].letras_miudas.join(", ")}
                          </p>
                        )}
                      </div>
                    )}
                  </article>
                ))}
              </div>
            </>
          )}

          {drawerOpen && activeTab === "organizador" && (
            <div className="space-y-3 overflow-auto pr-1 text-sm">
              <div className="rounded-xl border border-emerald-300/25 bg-emerald-950/40 p-3">
                <p className="flex items-center gap-2 text-xs font-semibold text-emerald-100">
                  <Receipt size={14} />
                  Rendimento e contas
                </p>
                <label className="mt-2 block text-[11px] text-zinc-400">
                  Rendimento mensal (estimado)
                </label>
                <div className="mt-1 flex gap-2">
                  <input
                    type="number"
                    min={0}
                    step={0.01}
                    placeholder="Ex: 3500"
                    className="flex-1 rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm text-white"
                    value={monthlyIncome || ""}
                    onChange={(e) => persistMonthlyIncome(Number(e.target.value))}
                  />
                </div>
                <p className="mt-2 text-xs text-zinc-300">
                  Contas em aberto (scans):{" "}
                  <span className="font-semibold">{formatBRL(openBillsTotal)}</span>
                </p>
                <p className="mt-1 text-xs text-zinc-300">
                  Despesas fixas do mes:{" "}
                  <span className="font-semibold">{formatBRL(fixedMonthlyTotal)}</span>
                </p>
                <p className="mt-1 text-xs text-zinc-400">
                  Total comprometido: <span className="font-semibold text-zinc-200">{formatBRL(totalCommitted)}</span>
                </p>
                <p className="mt-1 text-xs text-zinc-300">
                  Sobra estimada:{" "}
                  <span
                    className={`font-semibold ${leftoverAfterCommitted > 0 ? "text-emerald-300" : "text-amber-300"}`}
                  >
                    {formatBRL(leftoverAfterCommitted)}
                  </span>
                </p>
                <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
                  Sobra = rendimento − (scans em aberto + fixos ativos). Nada de banco conectado — so o que
                  voce cadastrou.
                </p>
              </div>

              <div className="rounded-xl border border-white/15 bg-white/5 p-3">
                <p className="flex items-center gap-2 text-xs font-semibold text-zinc-200">
                  <Repeat size={14} />
                  Despesas fixas do mes
                </p>
                <p className="mt-1 text-[11px] text-zinc-500">
                  Aluguel, internet, mensalidade — somam na sobra e no &quot;Posso gastar X?&quot;.
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <input
                    type="text"
                    placeholder="Nome"
                    className="min-w-[100px] flex-1 rounded-lg border border-white/15 bg-black/40 px-2 py-1.5 text-xs text-white"
                    value={newFixedName}
                    onChange={(e) => setNewFixedName(e.target.value)}
                  />
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder="Valor R$"
                    className="w-24 rounded-lg border border-white/15 bg-black/40 px-2 py-1.5 text-xs text-white"
                    value={newFixedValor}
                    onChange={(e) => setNewFixedValor(e.target.value)}
                  />
                  <input
                    type="number"
                    min={1}
                    max={28}
                    title="Dia do vencimento"
                    className="w-16 rounded-lg border border-white/15 bg-black/40 px-2 py-1.5 text-xs text-white"
                    value={newFixedDia}
                    onChange={(e) => setNewFixedDia(Number(e.target.value))}
                  />
                  <button
                    type="button"
                    onClick={() => addFixedExpense()}
                    className="rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white"
                  >
                    Adicionar
                  </button>
                </div>
                <ul className="mt-2 space-y-1.5">
                  {fixedExpenses.length === 0 && (
                    <li className="text-[11px] text-zinc-500">Nenhuma fixa cadastrada.</li>
                  )}
                  {fixedExpenses.map((f) => (
                    <li
                      key={f.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 text-[11px]"
                    >
                      <span className={`font-medium ${f.ativo ? "text-zinc-100" : "text-zinc-500 line-through"}`}>
                        {f.nome} · dia {f.diaVencimento} · {formatBRL(f.valor)}
                      </span>
                      <span className="flex gap-1">
                        <button
                          type="button"
                          className="rounded border border-white/15 px-2 py-0.5 text-[10px]"
                          onClick={() =>
                            persistFixed(
                              fixedExpenses.map((x) =>
                                x.id === f.id ? { ...x, ativo: !x.ativo } : x,
                              ),
                            )
                          }
                        >
                          {f.ativo ? "Pausar" : "Ativar"}
                        </button>
                        <button
                          type="button"
                          className="rounded border border-red-400/30 px-2 py-0.5 text-[10px] text-red-200"
                          onClick={() => persistFixed(fixedExpenses.filter((x) => x.id !== f.id))}
                        >
                          Excluir
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="rounded-xl border border-white/15 bg-white/5 p-3">
                <p className="text-xs font-semibold text-zinc-200">Posso gastar X? (ex.: jantar fora)</p>
                <p className="mt-1 text-[11px] text-zinc-500">
                  Tres niveis de resposta — com colchao de seguranca que voce define.
                </p>
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  <div className="min-w-[120px] flex-1">
                    <label className="text-[10px] text-zinc-500">Quanto quer gastar?</label>
                    <input
                      type="text"
                      inputMode="decimal"
                      placeholder="Ex: 200"
                      className="mt-0.5 w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm text-white"
                      value={spendAsk}
                      onChange={(e) => setSpendAsk(e.target.value)}
                    />
                  </div>
                  <div className="w-28">
                    <label className="text-[10px] text-zinc-500">Colchao (R$)</label>
                    <input
                      type="number"
                      min={0}
                      step={10}
                      className="mt-0.5 w-full rounded-lg border border-white/15 bg-black/40 px-2 py-2 text-sm text-white"
                      value={spendCushion || ""}
                      onChange={(e) => persistSpendCushion(Number(e.target.value))}
                    />
                  </div>
                </div>
                {spendAdvice && (
                  <div
                    className={`mt-3 rounded-lg border p-2 text-xs leading-relaxed ${
                      spendAdvice.tier === "confortavel"
                        ? "border-emerald-400/35 bg-emerald-950/50 text-emerald-100"
                        : spendAdvice.tier === "apertado"
                          ? "border-amber-400/35 bg-amber-950/40 text-amber-100"
                          : "border-red-400/35 bg-red-950/40 text-red-100"
                    }`}
                  >
                    <p className="font-semibold">{spendAdvice.title}</p>
                    <p className="mt-1 opacity-95">{spendAdvice.detail}</p>
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-violet-400/25 bg-violet-950/30 p-3">
                <p className="flex items-center gap-2 text-xs font-semibold text-violet-100">
                  <Bell size={14} />
                  Lembretes de vencimento
                </p>
                <p className="mt-1 text-[11px] leading-relaxed text-zinc-400">
                  Aviso no navegador quando uma conta nao paga vence nas proximas 48h. Uma vez por dia por
                  conta. Funciona melhor com o app aberto ou em segundo plano no celular (PWA).
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void tryEnableNotifications()}
                    className="rounded-lg border border-violet-300/40 bg-violet-600/30 px-3 py-1.5 text-xs font-semibold text-violet-100"
                  >
                    Pedir permissao de avisos
                  </button>
                  <label className="inline-flex items-center gap-2 rounded-lg border border-white/15 bg-black/30 px-3 py-1.5 text-xs text-zinc-200">
                    <input
                      type="checkbox"
                      checked={reminderDueEnabled}
                      onChange={(e) => void setReminderDueOn(e.target.checked)}
                      className="rounded border-white/30"
                    />
                    Avisar vencimentos (48h)
                  </label>
                </div>
              </div>

              <div className="rounded-xl border border-white/15 bg-white/5 p-3">
                <p className="flex items-center gap-2 text-xs font-semibold text-zinc-200">
                  <Target size={14} />
                  Metas de poupanca
                </p>
                <p className="mt-1 text-[11px] text-zinc-500">
                  Viagem, trocar de celular, reserva — pequenos passos visiveis motivam mais que promessa vazia.
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <input
                    type="text"
                    placeholder="Nome da meta"
                    className="min-w-[100px] flex-1 rounded-lg border border-white/15 bg-black/40 px-2 py-1.5 text-xs text-white"
                    value={newGoalName}
                    onChange={(e) => setNewGoalName(e.target.value)}
                  />
                  <input
                    type="text"
                    inputMode="decimal"
                    placeholder="Valor alvo"
                    className="w-28 rounded-lg border border-white/15 bg-black/40 px-2 py-1.5 text-xs text-white"
                    value={newGoalTarget}
                    onChange={(e) => setNewGoalTarget(e.target.value)}
                  />
                  <input
                    type="date"
                    className="w-[140px] rounded-lg border border-white/15 bg-black/40 px-2 py-1.5 text-xs text-white"
                    value={newGoalDate}
                    onChange={(e) => setNewGoalDate(e.target.value)}
                  />
                  <button
                    type="button"
                    onClick={() => addGoal()}
                    className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white"
                  >
                    Adicionar
                  </button>
                </div>
                <ul className="mt-2 space-y-2">
                  {goals.length === 0 && (
                    <li className="text-xs text-zinc-500">
                      Nenhuma meta — crie uma e acompanhe quando sobrar um pouco cada mes.
                    </li>
                  )}
                  {goals.map((g) => {
                    const pct = g.valorAlvo > 0 ? Math.min(100, (g.valorAtual / g.valorAlvo) * 100) : 0;
                    const hint = goalDateHint(g.dataAlvo);
                    const falta = Math.max(0, g.valorAlvo - g.valorAtual);
                    const meses =
                      leftoverAfterCommitted > 0 && falta > 0
                        ? Math.ceil(falta / Math.max(leftoverAfterCommitted, 1))
                        : null;
                    return (
                      <li
                        key={g.id}
                        className="rounded-lg border border-white/10 bg-black/30 p-2 text-xs"
                      >
                        <div className="flex justify-between gap-2">
                          <span className="font-medium text-zinc-100">{g.nome}</span>
                          <span className="text-zinc-400">
                            {formatBRL(g.valorAtual)} / {formatBRL(g.valorAlvo)}
                          </span>
                        </div>
                        {g.dataAlvo && (
                          <p className="mt-0.5 text-[10px] text-zinc-500">
                            Meta para {g.dataAlvo.split("-").reverse().join("/")}
                            {hint ? ` · ${hint}` : ""}
                          </p>
                        )}
                        {meses != null && meses <= 36 && falta > 0 && (
                          <p className="mt-1 text-[10px] text-emerald-200/80">
                            Se guardasse a sobra atual todo mes (ilustrativo): ~{meses} mes(es) para fechar a
                            meta. Ajuste conforme a vida real.
                          </p>
                        )}
                        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-zinc-800">
                          <div
                            className="h-full rounded-full bg-emerald-500 transition-all"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <div className="mt-2 flex gap-2">
                          <button
                            type="button"
                            className="rounded border border-white/15 px-2 py-1 text-[10px] text-zinc-300"
                            onClick={() =>
                              persistGoals(
                                goals.map((x) =>
                                  x.id === g.id
                                    ? {
                                        ...x,
                                        valorAtual: Math.min(x.valorAlvo, x.valorAtual + 50),
                                      }
                                    : x,
                                ),
                              )
                            }
                          >
                            +50
                          </button>
                          <button
                            type="button"
                            className="rounded border border-red-400/30 px-2 py-1 text-[10px] text-red-200"
                            onClick={() => persistGoals(goals.filter((x) => x.id !== g.id))}
                          >
                            Remover
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>
          )}

          <div className="mt-auto shrink-0 border-t border-white/10 pt-3">
            <p className="text-center text-xs leading-relaxed text-zinc-400">
              O Sentinela ajuda a organizar e a antecipar — sem prometer milagres. Os seus dados, o seu
              ritmo.
            </p>
            <p className="mt-1.5 text-center text-[11px] text-zinc-500">
              Versão {appVersion}
            </p>
          </div>
        </div>
      </section>

      {showUsageModal && (
        <div className="absolute inset-0 z-[55] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border border-white/15 bg-zinc-900 p-5">
            <h2 className="text-lg font-semibold text-white">Como vai usar o Sentinela?</h2>
            <p className="mt-1 text-sm text-zinc-400">
              Ajustamos dicas e textos ao seu perfil. Pode mudar depois nas configuracoes do
              navegador (localStorage).
            </p>
            <div className="mt-4 flex flex-col gap-2">
              <button
                type="button"
                onClick={() => persistUsageMode("familia")}
                className="w-full rounded-xl bg-emerald-600 py-3 text-sm font-semibold text-white"
              >
                Casa / familia
              </button>
              <button
                type="button"
                onClick={() => persistUsageMode("mei")}
                className="w-full rounded-xl border border-white/20 bg-white/5 py-3 text-sm font-semibold text-white"
              >
                MEI ou negocio
              </button>
            </div>
          </div>
        </div>
      )}

      {showUpgrade && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/65 p-4">
          <div className="w-full max-w-sm rounded-2xl border border-white/15 bg-zinc-900 p-5">
            <h2 className="text-lg font-semibold">Assine o Plano Ilimitado</h2>
            <p className="mt-1 text-sm text-zinc-300">
              Voce usou seus 2 scans gratuitos deste mes.
            </p>
            <button
              onClick={() => setShowUpgrade(false)}
              className="mt-4 w-full rounded-xl bg-white py-2 text-sm font-semibold text-black"
            >
              Entendi
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
