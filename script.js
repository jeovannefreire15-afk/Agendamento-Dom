// script.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.3.1/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/11.3.1/firebase-analytics.js";
import {
    getFirestore, collection, addDoc, getDocs,
    deleteDoc, doc, setDoc, getDoc
} from "https://www.gstatic.com/firebasejs/11.3.1/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "AIzaSyAuz7p8hwBYbYwe-W2xw6s1m80ToA93Lx4",
    authDomain: "projeto-agendamento-projetor.firebaseapp.com",
    projectId: "projeto-agendamento-projetor",
    storageBucket: "projeto-agendamento-projetor.firebasestorage.app",
    messagingSenderId: "388443857631",
    appId: "1:388443857631:web:b3a11057f365d27058bf6a",
    measurementId: "G-KCYMLTJW7K"
};

const app = initializeApp(firebaseConfig);
getAnalytics(app);
const db = getFirestore(app);

// ─────────────────────────────────────────────
//  HORÁRIO DE CORTE
//  Altere este valor para mudar o horário em que
//  o sistema passa a agendar para o próximo dia.
// ─────────────────────────────────────────────
const HORA_CORTE = 17;

// ─────────────────────────────────────────────
//  DATAS
//  Todas as funções usam o fuso horário de
//  Brasília (America/Sao_Paulo) explicitamente,
//  evitando erros quando o navegador ou servidor
//  estiver em UTC ou outro fuso.
// ─────────────────────────────────────────────

/**
 * Retorna um objeto Date ajustado para Brasília.
 * Usa Intl.DateTimeFormat para extrair os campos
 * corretamente independente do fuso do dispositivo.
 */
function agoraBrasilia() {
    const agora = new Date();
    const partes = new Intl.DateTimeFormat("pt-BR", {
        timeZone: "America/Sao_Paulo",
        year:     "numeric",
        month:    "2-digit",
        day:      "2-digit",
        hour:     "2-digit",
        minute:   "2-digit",
        hour12:   false
    }).formatToParts(agora);

    const get = (tipo) => parseInt(partes.find(p => p.type === tipo).value, 10);

    return {
        ano:    get("year"),
        mes:    get("month"),
        dia:    get("day"),
        hora:   get("hour"),
        minuto: get("minute")
    };
}

/**
 * Retorna true se o horário em Brasília já passou do corte.
 */
function aposHoraCorte() {
    return agoraBrasilia().hora >= HORA_CORTE;
}

/**
 * Retorna a data de hoje em YYYY-MM-DD no fuso de Brasília.
 */
function obterDataHoje() {
    const { ano, mes, dia } = agoraBrasilia();
    return `${ano}-${String(mes).padStart(2,"0")}-${String(dia).padStart(2,"0")}`;
}

/**
 * Retorna a "data de referência" do sistema:
 * - Antes das 17h (Brasília) → hoje
 * - A partir das 17h (Brasília) → próximo dia útil
 *
 * Esta é a data usada em TUDO: exibição, filtragem e agendamento.
 */
function obterDataReferencia() {
    const { ano, mes, dia, hora } = agoraBrasilia();

    // Monta um Date local com os valores de Brasília
    const d = new Date(ano, mes - 1, dia);

    if (hora >= HORA_CORTE) {
        d.setDate(d.getDate() + 1);
    }

    // Pula fins de semana
    while (d.getDay() === 0 || d.getDay() === 6) {
        d.setDate(d.getDate() + 1);
    }

    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

/**
 * Data de 7 dias atrás, para delimitar o histórico.
 */
function obterDataLimiteHistorico() {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function formatarDataExibicao(dataStr) {
    const [ano, mes, dia] = dataStr.split("-");
    return `${dia}/${mes}/${ano}`;
}

// ─────────────────────────────────────────────
//  LIMPEZA + HISTÓRICO
//
//  Regra simples:
//  - A limpeza só roda se o horário for >= 17h.
//  - A chave de controle é apenas a data do dia.
//  - Se já limpou hoje (após 17h), não faz nada.
//  - Antes de apagar, copia tudo para "historico".
//  - Histórico é mantido por 7 dias.
// ─────────────────────────────────────────────

async function limparHistoricoAntigo() {
    try {
        const limite = obterDataLimiteHistorico();
        const snap = await getDocs(collection(db, "historico"));
        const antigas = [];
        snap.forEach(docSnap => {
            const arquivado = docSnap.data().arquivadoEm;
            if (arquivado && arquivado < limite) {
                antigas.push(deleteDoc(doc(db, "historico", docSnap.id)));
            }
        });
        if (antigas.length > 0) {
            await Promise.all(antigas);
            console.log(`[Histórico] ${antigas.length} registro(s) antigo(s) removidos.`);
        }
    } catch (err) {
        console.error("[Histórico] Erro ao limpar antigos:", err);
    }
}

async function limparAgendamentos() {
    try {
        // Só executa após a hora de corte
        if (!aposHoraCorte()) {
            console.log("[Limpeza] Ainda não é hora de limpar.");
            return;
        }

        const hoje       = obterDataHoje();
        const configRef  = doc(db, "config", "ultimaLimpeza");
        const configSnap = await getDoc(configRef);
        const ultimaLimpeza = configSnap.exists()
            ? configSnap.data().dataLimpeza
            : null;

        // Já limpou hoje após as 17h
        if (ultimaLimpeza === hoje) {
            console.log("[Limpeza] Já realizada hoje:", hoje);
            return;
        }

        // Busca agendamentos cujo dia já encerrou (data <= hoje)
        const snap = await getDocs(collection(db, "agendamentos"));
        const dadosParaHistorico = [];
        const idsParaApagar = [];

        snap.forEach(docSnap => {
            const dados = docSnap.data();
            const deveApagar = dados.data && dados.data <= hoje;
            console.log(`[Limpeza] Documento: data=${dados.data} | hoje=${hoje} | deveApagar=${deveApagar} | professor=${dados.professor}`);
            if (deveApagar) {
                dadosParaHistorico.push(dados);
                idsParaApagar.push(docSnap.id);
            }
        });

        console.log(`[Limpeza] ${idsParaApagar.length} agendamento(s) encontrados para remover.`);

        if (idsParaApagar.length > 0) {
            // 1. Salva no histórico — um por um para garantir que cada documento é criado
            for (const dados of dadosParaHistorico) {
                await addDoc(collection(db, "historico"), {
                    professor:   dados.professor,
                    projetor:    dados.projetor,
                    horario:     dados.horario,
                    data:        dados.data,
                    arquivadoEm: hoje
                });
            }
            console.log(`[Histórico] ${dadosParaHistorico.length} registro(s) salvos.`);

            // 2. Só apaga depois que o histórico foi salvo com sucesso
            for (const id of idsParaApagar) {
                await deleteDoc(doc(db, "agendamentos", id));
            }
            console.log(`[Limpeza] ${idsParaApagar.length} agendamento(s) removidos.`);
        }

        // 3. Limpa histórico com mais de 7 dias
        await limparHistoricoAntigo();

        // 4. Registra que a limpeza foi feita — só aqui, após tudo ter sido executado
        await setDoc(configRef, { dataLimpeza: hoje });
        console.log("[Limpeza] Concluída para:", hoje);

    } catch (err) {
        console.error("[Limpeza] Erro:", err);
    }
}

// ─────────────────────────────────────────────
//  FIRESTORE — leitura
// ─────────────────────────────────────────────

async function carregarAgendamentos() {
    const snap = await getDocs(collection(db, "agendamentos"));
    const lista = [];
    snap.forEach(docSnap => lista.push({ id: docSnap.id, ...docSnap.data() }));
    return lista;
}

async function carregarHistorico() {
    const snap = await getDocs(collection(db, "historico"));
    const lista = [];
    snap.forEach(docSnap => lista.push({ id: docSnap.id, ...docSnap.data() }));
    return lista;
}

// ─────────────────────────────────────────────
//  HORÁRIOS DISPONÍVEIS
// ─────────────────────────────────────────────

async function atualizarHorariosDisponiveis() {
    const projetorSelect    = document.getElementById("projetor");
    const horariosContainer = document.getElementById("horarios-container");
    if (!projetorSelect || !horariosContainer) return;

    horariosContainer.innerHTML =
        '<span style="font-size:13px;color:var(--text-muted)">Carregando horários...</span>';

    const horarios = ["1º","2º","3º","4º","5º","Alm.","6º","7º","8º","9º"];
    const projetorSelecionado = projetorSelect.value;
    const dataRef = obterDataReferencia(); // usa a data de referência correta

    let horariosOcupados = [];
    try {
        const agendamentos = await carregarAgendamentos();
        horariosOcupados = agendamentos
            .filter(a => a.projetor === projetorSelecionado && a.data === dataRef)
            .map(a => a.horario);
    } catch (err) {
        console.error("[Horários] Erro:", err);
    }

    horariosContainer.innerHTML = "";
    horarios.forEach(horario => {
        const label    = document.createElement("label");
        const checkbox = document.createElement("input");
        checkbox.type  = "checkbox";
        checkbox.value = horario;
        checkbox.name  = "horario";

        if (horariosOcupados.includes(horario)) {
            checkbox.disabled = true;
            label.classList.add("horario-indisponivel");
        } else {
            label.classList.add("horario-disponivel");
        }
        label.appendChild(checkbox);
        label.appendChild(document.createTextNode(" " + horario));
        horariosContainer.appendChild(label);
    });
}

// ─────────────────────────────────────────────
//  TABELA (agendamentos.html)
// ─────────────────────────────────────────────

async function atualizarListaAgendamentos() {
    const tabela  = document.getElementById("tabela-agendamentos");
    const vazioEl = document.getElementById("tabela-vazia");
    const dataEl  = document.getElementById("data-exibicao");
    if (!tabela) return;

    const tbody = tabela.querySelector("tbody");
    if (!tbody) return;
    tbody.innerHTML = "";

    // Exibe a data de referência (não necessariamente hoje)
    const dataRef = obterDataReferencia();
    if (dataEl) dataEl.textContent = formatarDataExibicao(dataRef);

    let agendamentos = [];
    try {
        agendamentos = await carregarAgendamentos();
    } catch (err) {
        console.error("[Tabela] Erro:", err);
    }

    // Mostra apenas os agendamentos da data de referência
    const ativos = agendamentos.filter(a => a.data === dataRef);

    // Agrupa por professor + equipamento
    const agrupados = {};
    ativos.forEach(a => {
        const chave = `${a.professor}__${a.projetor}`;
        if (!agrupados[chave]) {
            agrupados[chave] = { professor: a.professor, projetor: a.projetor, horarios: [] };
        }
        agrupados[chave].horarios.push(a.horario);
    });

    const lista = Object.values(agrupados).sort((a, b) =>
        a.professor.localeCompare(b.professor)
    );

    if (vazioEl) vazioEl.style.display = lista.length === 0 ? "block" : "none";

    let ultimoProfessor = null;
    lista.forEach(a => {
        const tr = document.createElement("tr");
        if (a.professor !== ultimoProfessor) {
            tr.classList.add("tr-novo-professor");
            ultimoProfessor = a.professor;
        }
        tr.innerHTML = `
            <td>${a.professor}</td>
            <td>${a.projetor}</td>
            <td>${a.horarios.sort().join(", ")}</td>
        `;
        tbody.appendChild(tr);
    });
}

// ─────────────────────────────────────────────
//  GERENCIAR (gerenciar.html)
// ─────────────────────────────────────────────

function confirmarAcao(mensagem, callback) {
    const overlay = document.getElementById("modal-overlay");
    const msgEl   = document.getElementById("modal-msg");
    const btnSim  = document.getElementById("modal-confirmar");
    const btnNao  = document.getElementById("modal-cancelar");
    if (!overlay) return;

    msgEl.textContent = mensagem;
    overlay.style.display = "flex";

    const fechar = () => { overlay.style.display = "none"; };
    btnSim.onclick = () => { fechar(); callback(); };
    btnNao.onclick = fechar;
    overlay.onclick = (e) => { if (e.target === overlay) fechar(); };
}

async function excluirPorIds(ids) {
    for (const id of ids) {
        await deleteDoc(doc(db, "agendamentos", id));
    }
}

async function carregarGerenciar() {
    const painel  = document.getElementById("painel-gerenciar");
    const vazioEl = document.getElementById("gerenciar-vazio");
    if (!painel) return;

    painel.innerHTML = '<p style="color:var(--text-muted);font-size:14px;text-align:center;padding:20px">Carregando...</p>';

    const dataRef = obterDataReferencia();
    let agendamentos = [];
    try {
        agendamentos = await carregarAgendamentos();
    } catch (err) {
        console.error("[Gerenciar] Erro:", err);
    }

    // Mostra os agendamentos da data de referência
    const ativos = agendamentos.filter(a => a.data === dataRef);
    painel.innerHTML = "";

    if (ativos.length === 0) {
        if (vazioEl) vazioEl.style.display = "block";
        return;
    }
    if (vazioEl) vazioEl.style.display = "none";

    // Agrupa por professor
    const porProfessor = {};
    ativos.forEach(a => {
        if (!porProfessor[a.professor]) porProfessor[a.professor] = [];
        porProfessor[a.professor].push(a);
    });

    const professores = Object.keys(porProfessor).sort((a, b) => a.localeCompare(b));

    professores.forEach(professor => {
        const registros = porProfessor[professor];
        const ids = registros.map(r => r.id);

        const card = document.createElement("div");
        card.className = "gerenciar-card";

        const header = document.createElement("div");
        header.className = "gerenciar-card-header";
        header.innerHTML = `
            <div class="gerenciar-professor-info">
                <span class="gerenciar-avatar">${professor.charAt(0).toUpperCase()}</span>
                <span class="gerenciar-professor-nome">${professor}</span>
                <span class="gerenciar-badge">${ids.length} horário${ids.length > 1 ? "s" : ""}</span>
            </div>
            <button class="btn-excluir-todos" data-professor="${professor}">Excluir todos</button>
        `;
        card.appendChild(header);

        const porEquipamento = {};
        registros.forEach(r => {
            if (!porEquipamento[r.projetor]) porEquipamento[r.projetor] = [];
            porEquipamento[r.projetor].push(r);
        });

        const lista = document.createElement("div");
        lista.className = "gerenciar-lista";

        Object.entries(porEquipamento).forEach(([equipamento, regs]) => {
            const equipRow = document.createElement("div");
            equipRow.className = "gerenciar-equipamento";

            const equipNome = document.createElement("span");
            equipNome.className = "gerenciar-equip-nome";
            equipNome.textContent = equipamento;
            equipRow.appendChild(equipNome);

            const horariosDiv = document.createElement("div");
            horariosDiv.className = "gerenciar-horarios";

            regs.forEach(reg => {
                const chip = document.createElement("div");
                chip.className = "gerenciar-chip";
                chip.innerHTML = `
                    <span>${reg.horario}</span>
                    <button class="btn-excluir-chip" title="Excluir este horário" data-id="${reg.id}">✕</button>
                `;
                horariosDiv.appendChild(chip);
            });

            equipRow.appendChild(horariosDiv);
            lista.appendChild(equipRow);
        });

        card.appendChild(lista);
        painel.appendChild(card);
    });

    // Eventos
    painel.querySelectorAll(".btn-excluir-chip").forEach(btn => {
        btn.addEventListener("click", () => {
            confirmarAcao("Excluir este horário?", async () => {
                await excluirPorIds([btn.dataset.id]);
                await carregarGerenciar();
            });
        });
    });

    painel.querySelectorAll(".btn-excluir-todos").forEach(btn => {
        btn.addEventListener("click", () => {
            const professor = btn.dataset.professor;
            const ids = porProfessor[professor].map(r => r.id);
            confirmarAcao(
                `Excluir todos os ${ids.length} agendamento(s) de "${professor}"?`,
                async () => {
                    await excluirPorIds(ids);
                    await carregarGerenciar();
                }
            );
        });
    });
}

// ─────────────────────────────────────────────
//  HISTÓRICO SEMANAL (historico.html)
// ─────────────────────────────────────────────

async function carregarPaginaHistorico() {
    const painel  = document.getElementById("painel-historico");
    const vazioEl = document.getElementById("historico-vazio");
    if (!painel) return;

    painel.innerHTML = '<p style="color:var(--text-muted);font-size:14px;text-align:center;padding:20px">Carregando histórico...</p>';

    let historico = [];
    try {
        historico = await carregarHistorico();
    } catch (err) {
        console.error("[Histórico] Erro:", err);
    }

    painel.innerHTML = "";

    if (historico.length === 0) {
        if (vazioEl) vazioEl.style.display = "block";
        return;
    }
    if (vazioEl) vazioEl.style.display = "none";

    // Agrupa por data (mais recente primeiro)
    const porData = {};
    historico.forEach(a => {
        if (!porData[a.data]) porData[a.data] = [];
        porData[a.data].push(a);
    });

    const datas = Object.keys(porData).sort((a, b) => b.localeCompare(a));

    datas.forEach(data => {
        const registros = porData[data];

        // Título da data
        const tituloDiv = document.createElement("div");
        tituloDiv.className = "historico-data-titulo";
        tituloDiv.textContent = formatarDataExibicao(data);
        painel.appendChild(tituloDiv);

        // Tabela da data
        const card = document.createElement("div");
        card.className = "card table-card";
        card.style.marginBottom = "16px";

        const tableScroll = document.createElement("div");
        tableScroll.className = "table-scroll";

        const table = document.createElement("table");
        table.innerHTML = `
            <thead>
                <tr>
                    <th>Professor</th>
                    <th>Equipamento</th>
                    <th>Horários</th>
                </tr>
            </thead>
        `;
        const tbody = document.createElement("tbody");

        // Agrupa por professor+equipamento dentro da data
        const agrupados = {};
        registros.forEach(a => {
            const chave = `${a.professor}__${a.projetor}`;
            if (!agrupados[chave]) {
                agrupados[chave] = { professor: a.professor, projetor: a.projetor, horarios: [] };
            }
            agrupados[chave].horarios.push(a.horario);
        });

        Object.values(agrupados)
            .sort((a, b) => a.professor.localeCompare(b.professor))
            .forEach(a => {
                const tr = document.createElement("tr");
                tr.innerHTML = `
                    <td>${a.professor}</td>
                    <td>${a.projetor}</td>
                    <td>${a.horarios.sort().join(", ")}</td>
                `;
                tbody.appendChild(tr);
            });

        table.appendChild(tbody);
        tableScroll.appendChild(table);
        card.appendChild(tableScroll);
        painel.appendChild(card);
    });
}

// ─────────────────────────────────────────────
//  TOAST
// ─────────────────────────────────────────────

function mostrarToast(mensagem, tipo = "success") {
    const toast = document.getElementById("toast");
    if (!toast) return;
    toast.textContent = mensagem;
    toast.className = `toast toast--${tipo}`;
    setTimeout(() => { toast.className = "toast"; }, 4000);
}

// ─────────────────────────────────────────────
//  INICIALIZAÇÃO
// ─────────────────────────────────────────────

window.addEventListener("load", async () => {

    // Aguarda a limpeza terminar antes de qualquer outra operação.
    // Isso evita que um agendamento feito logo após o carregamento
    // seja apagado por uma limpeza ainda em andamento em paralelo.
    await limparAgendamentos();

    const form           = document.getElementById("agendamento-form");
    const projetorSelect = document.getElementById("projetor");

    // ── index.html
    if (form && projetorSelect) {
        await atualizarHorariosDisponiveis();
        projetorSelect.addEventListener("change", atualizarHorariosDisponiveis);

        form.addEventListener("submit", async (e) => {
            e.preventDefault();

            const professor = document.getElementById("professor").value.trim();
            const projetor  = projetorSelect.value;
            const horariosSelecionados = Array.from(
                document.querySelectorAll("input[name='horario']:checked")
            ).map(cb => cb.value);
            const dataRef = obterDataReferencia();

            if (!professor || !projetor || horariosSelecionados.length === 0) {
                mostrarToast("Preencha todos os campos e selecione ao menos um horário.", "error");
                return;
            }

            const btnSubmit = form.querySelector(".btn-agendar");
            if (btnSubmit) {
                btnSubmit.disabled = true;
                btnSubmit.querySelector(".btn-text").textContent = "Salvando...";
            }

            try {
                for (const horario of horariosSelecionados) {
                    await addDoc(collection(db, "agendamentos"), {
                        professor, projetor, horario, data: dataRef
                    });
                }
                mostrarToast(`Agendamento confirmado para ${formatarDataExibicao(dataRef)}! ✓`);
                form.reset();
                await atualizarHorariosDisponiveis();
            } catch (err) {
                console.error("[Submit] Erro:", err);
                mostrarToast("Erro ao salvar. Verifique sua conexão.", "error");
            } finally {
                if (btnSubmit) {
                    btnSubmit.disabled = false;
                    btnSubmit.querySelector(".btn-text").textContent = "Confirmar Agendamento";
                }
            }
        });
    }

    // ── agendamentos.html
    await atualizarListaAgendamentos();

    // ── gerenciar.html
    await carregarGerenciar();

    // ── historico.html
    await carregarPaginaHistorico();
});
