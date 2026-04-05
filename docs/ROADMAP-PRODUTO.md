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

## 2.5 Contratos, golpes e o que **não** é prioridade agora

### Fora de foco por enquanto: vertente saúde

- **Decisão:** não investir em produto, UX dedicada, landing nem narrativa centrada em **saúde** nesta fase.
- **Código:** a categoria técnica `saude` no pipeline (`financeira` | `saude` | `legal`) pode permanecer para classificação ocasional de documentos; **sem** prometer fluxo “Sentinela para saúde” ao utilizador.

### Dentro do foco: contratos (leigo) + anti-golpe

**Promessa central (contratos):** **tirar o juridiquês** e **explicar em linguagem simples** o que está escrito — o que cada parte tem de fazer, quanto custa, até quando, o que acontece se rescindir, etc.

**Âmbito de tipos de contrato:** na **entrada**, pode ser **qualquer** contrato que o utilizador envie (empréstimo, arrendamento/aluguel, compra de carro ou casa, prestação de serviços, adesão, financiamento, entre outros). Na **evolução do produto**, tratar por **priorização progressiva de tipologias**: começar com checklists e prompts mais ricos para os mais frequentes (ex.: aluguel, crédito ao consumo, compra de bem) e manter resumo **genérico mas útil** para os restantes até haver modelo ou guia específico.

**Expectativa honesta:** contratos **muito longos**, PDF fraco ou letra ilegível **aumentam erro** — posicionar como **assistência de leitura**, não como substituto de revisão humana em decisões de alto impacto.

| Tema | Intenção | Guarda-rails |
|------|----------|--------------|
| **Contratos** | Resumo em linguagem simples (anti-juridiquês); destaque de prazos, valores, multas, fidelidade, renovação automática, juros ou encargos *sinalizados como “atenção”*. | Sempre avisar: **informação educativa**, **não substitui advogado**; em caso de dúvida, profissional qualificado. |
| **Golpes (boleto / fatura)** | Evoluir heurísticas + IA: beneficiário estranho, valor fora do padrão, URLs suspeitas, inconsistências; reforçar `alerta_fraude` e `motivo_fraude`. | Não garantir “é golpe” com 100% de certeza — linguagem de **risco** e “vale verificar”. |
| **Contrato “ruim” para o cliente** | Explicar **assimetrias** que um leigo costuma não ver (cláusulas ocultas, encargos, rescisão onerosa). | Mesmo disclaimer jurídico; evitar tom alarmista; opcional **segunda opinião** (já há padrão `second-opinion` na API). |

**Ângulo competitivo:** o banco organiza pagamentos **dele**; o Sentinela pode ser o **“tradutor” de papelada e de risco** sobre ficheiros que o utilizador já tem — contrato de aluguel, adesão, financiamento, boleto duvidoso — **sem** executar pagamento.

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
- **Produto / marketing em vertente saúde** — congelado até nova decisão (ver §2.5).

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

## 8. Benchmark — app Itaú (“Pague contas” / pagamentos) vs Sentinela

Referência pública (site e ajuda Itaú): [pagamentos no app](https://www.itau.com.br/atendimento-itau/para-voce/pagamentos-transferencias/como-fazer-pagamentos-pelo-aplicativo-itau), [Pague Contas](https://www.itau.com.br/cartoes/servicos/pague-contas), [DDA](https://www.itau.com.br/atendimento-itau/para-voce/pagamentos-transferencias/como-funciona-o-pagamento-por-debito-direto-autorizado-dda). O Itaú é **banco**: executa pagamento, lê código de barras na câmara **dentro do ecossistema da conta**. O Sentinela **não compete** nisso; inspira-se em **organização e hábito**.

| O que o Itaú faz bem (ideias para o Sentinela) | Como adaptar sem virar banco |
|-----------------------------------------------|------------------------------|
| **Agendar pagamento para data futura** | “Lembrar-me neste dia” / calendário por conta (já alinhado a lembretes no roadmap). |
| **Pagar no dia ou agendar** | Nós: “Marcar como paga” + lembrete antes do vencimento (não debitar). |
| **Lista de contas/boletos com filtros (a vencer / vencidos)** | Já próximo dos filtros “Vencendo em 7 dias” / reforçar **vencidos vs próximos** como no DDA. |
| **DDA (boletos no CPF na rede)** | Não replicar DDA; opcional futuro: importar **exportação** que o utilizador descarrega do banco (CSV/PDF) — Fase 3. |
| **Comprovante / histórico longo** | Sentinela: histórico de scans + export CSV/PDF resumo; política de retenção clara na UI. |
| **Débito automático / parcelamento de boletos** | Fora do escopo; mencionar na copy só como “nós não movimentamos dinheiro”. |
| **Leitura de código de barras** | Itaú na app do banco; Sentinela: **foto/PDF + IA** (diferencial). |

**Resumo:** roubar **clareza de lista, datas e lembretes**, não **execução de pagamento** nem **ligação à conta**.

---

*Este ficheiro pode ser referenciado nas Cursor Rules do Sentinela para manter o rumo entre sessões.*
