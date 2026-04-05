# Sentinela — roadmap de produto (estruturado)

Documento vivo: alinha visão de negócio, mensagem de confiança e entregas técnicas.  
Última organização: sprint mental “4 ideias” + demais elevadores de patamar.

**Implementado no código (Sprint 1 — MVP):** despesas fixas + sobra ajustada, lembretes de vencimento (48h, notificação do navegador), card PNG para compartilhar, PWA (`manifest`, `sw.js`, registo do SW).

---

## 1. Princípios fixos (não negociar)

| Princípio | Na prática |
|-----------|------------|
| **Sem acesso ao banco** | Não pedir senha bancária, não “conectar conta”, não Open Banking como core. Entrada = **arquivos que o usuário já tem** (PDF de extrato, boleto, fatura, foto). |
| **Promessa honesta** | Organização, previsibilidade, menos susto — **não** “ficar rico” nem investimento milagroso. |
| **Transparência** | Dizer o que a IA inferiu e permitir correção rápida; política de dados legível; opção de apagar dados (LGPD como feature). |

**Mensagens-canal** (repetir no app, landing, lojas):

- *“O Sentinela não liga ao seu banco. Você envia o PDF ou a foto; nós lemos e organizamos.”*
- *“Sem promessa de riqueza — promessa de clareza no mês.”*

---

## 2. As quatro ideias prioritárias (Sprint 1 — maior impacto desejo/uso)

Ordem sugerida de implementação:

### 2.1 Lembretes de vencimento

- **Objetivo:** fechar o ciclo “organizei → não esqueço”.
- **MVP:** notificação do navegador **no dia** ou **1 dia antes** (agendar com `Notification` + `setTimeout` / `scheduling API` onde suportado), baseado em `vencimento` dos scans.
- **Evolutivo:** e-mail (Resend/SendGrid + edge function) ou push web com Service Worker para funcionar com aba fechada.
- **Dependências:** permissão já pedida no app; persistir preferências (quais contas avisar, horário).

### 2.2 Despesas fixas do mês

- **Objetivo:** projeção do mês **além** do que foi digitalizado (aluguel, escola, internet, mensalidades).
- **MVP:** lista em `localStorage` (nome, valor, dia do vencimento, ativo/inativo); somar ao “total comprometido” e à sobra usada em “Posso gastar X?”.
- **Evolutivo:** sincronizar com Supabase (`device_id`) para não perder ao trocar de aparelho.

### 2.3 Card para compartilhar o resumo

- **Objetivo:** viralidade e prova social (“olha como fiquei organizado”).
- **MVP:** gerar **imagem** ou **texto rico** (canvas/`html-to-image` ou SVG) com: total a vencer na semana, N contas, tom visual Sentinela; botão “Compartilhar” (Web Share API + fallback download).
- **Evolutivo:** templates (MEI vs família), marca d’água leve.

### 2.4 PWA instalável

- **Objetivo:** sensação de app, ícone na home, abrir direto no fluxo “Anexar”.
- **MVP:** `manifest.json`, ícones, `service worker` mínimo (cache shell), meta tags `theme-color`, display `standalone`.
- **Evolutivo:** offline só para shell + fila de upload quando voltar online.

---

## 3. Fase 2 — patamar “produto sério” (após Sprint 1)

| Item | Descrição |
|------|-----------|
| **Conciliação leve** | Ao registrar novo scan, sugerir: “Parece a mesma conta do mês passado?” — merge ou vincular, reduzir duplicatas. |
| **“Posso gastar X?” em cenários** | Duas linhas: ex. “Se pagar tudo até dia 15” vs “Se atrasar a conta Z” — ensina sem julgar. |
| **Explicar a leitura da IA** | Por item: “Valor lido do campo total”, “Vencimento do código de barras” + botão **Corrigir** inline. |
| **Apagar tudo (LGPD)** | Um toque: limpar `localStorage` + pedidos ao Supabase para apagar `sentinela_scans` do `device_id`. |
| **Modo leitura / contador** | Link ou exportação “somente visualização” (PDF ou página read-only) sem editar — confiança em dupla. |

---

## 4. Fase 3 — crescimento e marca

| Item | Descrição |
|------|-----------|
| **Landing** | 3 blocos visuais: caos (PDFs no WhatsApp) → Sentinela (linha do tempo) → “Posso jantar fora?”. |
| **Vídeo curto (15s)** | Só o fluxo: PDF grande → overlay “muitas páginas” → lista; prova **robustez**. |
| **Importar CSV/OFX** (opcional) | Meio-termo sem banco: usuário exporta do banco e sobe arquivo — mais estrutura que PDF puro. |

---

## 5. O que fica de fora (por decisão explícita)

- **Open Banking / Open Finance** como núcleo — não alinhar com medo de segurança do público-alvo; mensagem sempre **anti-assustar**.
- Investimentos, score, “multiplicar patrimônio” — fora do escopo narrativo.

---

## 6. Métricas sugeridas (validar cada fase)

- **Retenção D7:** voltou na semana após primeiro scan?
- **Segundo scan:** prova de hábito.
- **Partilhas:** quantos cards/exportações por semana.
- **Instalações PWA:** `beforeinstallprompt` / analytics.
- **Lembretes:** taxa de permissão concedida e de clique na notificação.

---

## 7. Mapa rápido: onde isso toca no código atual

| Entrega | Onde costuma viver |
|---------|-------------------|
| Copy “sem banco” | `app/page.tsx`, `app/layout.tsx`, futura `landing` |
| Despesas fixas | novo módulo + `localStorage` / Supabase; somar em cálculos do Organizador |
| Lembretes | cliente: agendamento + `Notification`; depois SW ou API |
| Card compartilhar | componente + canvas ou biblioteca de imagem |
| PWA | `public/manifest.json`, `next` config, SW |
| Apagar tudo | rota API + botão em UI |
| Conciliação | heurística em `page.tsx` ou API ao inserir scan |

---

*Este ficheiro pode ser referenciado nas Cursor Rules do Sentinela para manter o rumo entre sessões.*
