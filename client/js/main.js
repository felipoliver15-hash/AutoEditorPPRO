// Auto Editor - Panel Logic

var cs          = new CSInterface();
var loadedJSON  = null;  // objeto JSON de mapeamento carregado
var transcriptWords = []; // palavras com timestamps (Premiere JSON) — modo preciso
var srtEntries  = [];    // entradas SRT — fallback
var _atomCache    = null; // stream de átomos normalizados da transcrição (findPhraseTime)
var _atomCacheSrc = null; // referência de transcriptWords usada pra montar o cache

// Formata o NÚMERO do preço conforme o idioma do projeto (loadedJSON.language):
//   - inglês ("en", "en-US"...) → decimal com PONTO:  "240" → "240.00"
//   - português/outros          → decimal com VÍRGULA: "240" → "240,00"
// Em ambos remove o símbolo de moeda (R$, US$, $, €) — o símbolo vem do TEMPLATE.
function formatPriceByLang(val, lang) {
    var n = String(val == null ? '' : val).replace(/^\s*(R\$|US\$|USD|\$|€)\s*/i, '').replace(/^\s+|\s+$/g, '');
    if (!n) return '';
    var isEN = /^en/i.test(String(lang || ''));
    if (isEN) {
        n = n.replace(',', '.');                 // "240,00" → "240.00"
        return /\.\d/.test(n) ? n : n + '.00';
    }
    n = n.replace('.', ',');                      // "240.00" → "240,00"
    return /,\d/.test(n) ? n : n + ',00';
}

// Janelas usáveis de um vídeo do bin (in/out MÚLTIPLO):
//   - se tem marcadores de REGIÃO → cada região é uma janela (TÊM PRIORIDADE);
//   - senão → o in/out simples [inP, outP];
//   - senão (nada marcado) → o vídeo inteiro.
// Cada janela: { name, path, winStart, winLen, key }. O global_fill/sequencial
// ciclam entre as janelas como se fossem clipes separados.
function _videoWindows(v) {
    var name = v.name, path = v.path || null;
    if (v.regions && v.regions.length) {
        var ws = [];
        for (var i = 0; i < v.regions.length; i++) {
            var r = v.regions[i], len = (r.end - r.start);
            if (len > 0.1) ws.push({ name: name, path: path, winStart: r.start, winLen: len, key: name + "#r" + i });
        }
        if (ws.length) return ws;
    }
    var inP = v.inP || 0, outP = (v.outP || 0);
    var len2 = (v.dur && v.dur > 0.1) ? v.dur : Math.max(0.1, outP - inP);
    return [{ name: name, path: path, winStart: inP, winLen: len2, key: name + "#io" }];
}

// Chave do projeto atual no localStorage (preenchida em initProjectPersistence)
var _projectKey = "autoeditor_default";

// Números dos produtos já criados neste projeto (persistidos no localStorage)
var _createdProducts = [];

// ─── INIT ────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", function () {
    loadConfig();
    initTabs();
    initMontar();
    restoreStockFolder(); // pasta de stock é global (todos os projetos)
    initIA();
    initTemplates();
    initRecursos();
    initCapitulos();
    refreshSequenceInfo();
    initProjectPersistence();
    initPluginUpdate();
});

// ─── TABS ─────────────────────────────────────────────────────────────────────

function initTabs() {
    document.querySelectorAll(".tab").forEach(function (btn) {
        btn.addEventListener("click", function () {
            document.querySelectorAll(".tab").forEach(function (b) { b.classList.remove("active"); });
            document.querySelectorAll(".tab-content").forEach(function (c) { c.classList.remove("active"); });
            btn.classList.add("active");
            document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
            if (btn.dataset.tab === "templates") refreshTemplates();
            if (btn.dataset.tab === "recursos") { refreshTemplateSeqSection(); checkYtDlpUpdate(); }
        });
    });
}

// ─── CAPÍTULOS (YouTube) ────────────────────────────────────────────────────

// Chave localStorage para tags/benefícios dos capítulos (por projeto)
var CHAPTERS_TAGS_STORAGE = "autoeditor_chapter_tags";

function _chapterTagsKey() {
    return _projectKey + "_chapter_tags";
}

function _loadChapterTags() {
    try { return JSON.parse(localStorage.getItem(_chapterTagsKey()) || "{}"); } catch (e) { return {}; }
}

function _saveChapterTag(timeKey, val) {
    try {
        var tags = _loadChapterTags();
        tags[timeKey] = val;
        localStorage.setItem(_chapterTagsKey(), JSON.stringify(tags));
    } catch (e) {}
}

function _copyText(text, statusEl) {
    var ok = false;
    try {
        var ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand("copy");
        document.body.removeChild(ta);
    } catch (e) {}
    if (statusEl) {
        statusEl.textContent = ok ? "copiado!" : "selecione e copie (Ctrl+C)";
        setTimeout(function () { if (statusEl) statusEl.textContent = ""; }, 2500);
    }
}

function initCapitulos() {
    var status = document.getElementById("chapters-copy-status");

    var btnNames = document.getElementById("btn-copy-names");
    if (btnNames) btnNames.addEventListener("click", function () {
        var rows = document.querySelectorAll("#chapters-list .chap-row");
        if (!rows || !rows.length) { if (status) status.textContent = "nada pra copiar"; return; }
        var lines = [];
        rows.forEach(function (row) {
            var ts = row.getAttribute("data-ts") || "";
            var name = (row.querySelector(".chap-name") || {}).textContent || "";
            lines.push(ts + " " + name);
        });
        _copyText(lines.join("\n"), status);
    });

    var btnTags = document.getElementById("btn-copy-tags");
    if (btnTags) btnTags.addEventListener("click", function () {
        var rows = document.querySelectorAll("#chapters-list .chap-row");
        if (!rows || !rows.length) { if (status) status.textContent = "nada pra copiar"; return; }
        var lines = [];
        rows.forEach(function (row) {
            var ts = row.getAttribute("data-ts") || "";
            var input = row.querySelector(".chap-tag");
            var val = input ? input.value.trim() : "";
            if (val) lines.push(ts + " " + val);
        });
        if (!lines.length) { if (status) status.textContent = "nenhum benefício preenchido"; return; }
        _copyText(lines.join("\n"), status);
    });

    var rbtn = document.getElementById("btn-refresh-chapters");
    if (rbtn) rbtn.addEventListener("click", refreshChaptersFromMarkers);
}

// Relê os marcadores de sequência da timeline e regera os tempos dos capítulos
// (caso o usuário tenha movido algum marcador depois da montagem).
function refreshChaptersFromMarkers() {
    var status = document.getElementById("chapters-refresh-status");
    if (status) status.textContent = "lendo marcadores…";
    cs.evalScript("getChaptersFromMarkers()", function (raw) {
        var r = {};
        try { r = JSON.parse(raw); } catch (e) {}
        if (r && r.ok && r.chapters && r.chapters.length) {
            renderChapters(r.chapters);
            if (status) status.textContent = r.chapters.length + " capítulo(s) atualizado(s)";
        } else if (r && r.ok) {
            if (status) status.textContent = "nenhum marcador na sequência ativa";
        } else {
            if (status) status.textContent = "erro: " + (r.error || "desconhecido");
        }
    });
}

// Segundos → "M:SS" (ou "H:MM:SS" se passar de 1h). Primeiro capítulo = 0:00.
function fmtTimestamp(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    function pad(n) { return (n < 10 ? "0" : "") + n; }
    return (h > 0) ? (h + ":" + pad(m) + ":" + pad(s)) : (m + ":" + pad(s));
}

// Preenche a aba Capítulos com linhas editáveis (nome + benefício).
function renderChapters(chapters) {
    var container = document.getElementById("chapters-list");
    if (!container || !chapters || !chapters.length) return;
    var savedTags = _loadChapterTags();
    container.innerHTML = "";

    // Cabeçalho
    var hdr = document.createElement("div");
    hdr.style.cssText = "display:grid;grid-template-columns:56px 1fr 1fr;gap:4px;padding:2px 0 4px;border-bottom:1px solid #444;color:#888;font-size:10px";
    hdr.innerHTML = "<span>tempo</span><span>nome</span><span>benefício (editável)</span>";
    container.appendChild(hdr);

    chapters.forEach(function (c) {
        var ts = fmtTimestamp(c.time);
        var timeKey = ts; // chave para localStorage

        // Benefício: prioridade → marcador.comments → localStorage salvo → ""
        var savedTag = savedTags[timeKey] !== undefined ? savedTags[timeKey] : (c.tag || "");

        var row = document.createElement("div");
        row.className = "chap-row";
        row.setAttribute("data-ts", ts);
        row.style.cssText = "display:grid;grid-template-columns:56px 1fr 1fr;gap:4px;align-items:center;padding:3px 0;border-bottom:1px solid #333";

        var tsSpan = document.createElement("span");
        tsSpan.style.cssText = "color:#888";
        tsSpan.textContent = ts;

        var nameSpan = document.createElement("span");
        nameSpan.className = "chap-name";
        nameSpan.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#ddd";
        nameSpan.title = c.title || "";
        nameSpan.textContent = c.title || "";

        var tagInput = document.createElement("input");
        tagInput.className = "chap-tag";
        tagInput.type = "text";
        tagInput.value = savedTag;
        tagInput.placeholder = "ex: mais barato";
        tagInput.style.cssText = "background:#1e1e1e;color:#ddd;border:1px solid #444;border-radius:3px;padding:2px 5px;font-size:11px;font-family:monospace;width:100%;box-sizing:border-box";
        tagInput.addEventListener("input", function () {
            _saveChapterTag(timeKey, tagInput.value);
        });

        row.appendChild(tsSpan);
        row.appendChild(nameSpan);
        row.appendChild(tagInput);
        container.appendChild(row);
    });
}

// ─── PASTA RAIZ ───────────────────────────────────────────────────────────────

// Campo "Pasta raiz" foi removido (mídia vem dos bins PROD_N agora). Mantido como
// stub vazio pra não quebrar chamadas antigas.
function getRootFolder() {
    var el = document.getElementById("root-folder");
    return el ? (el.value || "").trim().replace(/[\/\\]+$/, "") : "";
}

// ── Pasta de stock videos (opcional) ────────────────────────────────────────
// GLOBAL (vale pra todos os projetos) — salva numa chave própria do localStorage.
var STOCK_FOLDER_STORAGE = "autoeditor_stock_folder";

function getStockFolder() {
    var el = document.getElementById("stock-folder");
    return el ? (el.value || "").trim().replace(/[\/\\]+$/, "") : "";
}

function setStockFolder(path) {
    document.getElementById("stock-folder").value = path;
    updateStockFolderStatus(path);
    try { localStorage.setItem(STOCK_FOLDER_STORAGE, path || ""); } catch (e) {}
}

// Carrega a pasta de stock global (chamado no init).
function restoreStockFolder() {
    try {
        var saved = localStorage.getItem(STOCK_FOLDER_STORAGE);
        if (saved && document.getElementById("stock-folder")) {
            document.getElementById("stock-folder").value = saved;
            updateStockFolderStatus(saved);
        }
    } catch (e) {}
}

function updateStockFolderStatus(path) {
    var hint = document.getElementById("stock-folder-status");
    if (!hint) return;
    if (!path) {
        hint.textContent = "nenhuma pasta selecionada";
        hint.className   = "root-folder-hint";
        return;
    }
    hint.textContent = path;
    hint.className   = "root-folder-hint ok";
}

function browseStockFolder() {
    cs.evalScript("selectFolder()", function (raw) {
        try {
            var data = JSON.parse(raw);
            if (data.cancelled || data.error) return;
            setStockFolder(data.path);
            log("Pasta de stock definida: " + data.path, "ok");
        } catch (e) { /* silencioso */ }
    });
}

// Escolhe um vídeo aleatório de <stockRoot>/<subfolder>. Retorna caminho ou null.
function pickRandomStock(stockRoot, subfolder) {
    var fs = tryNodeRequire('fs');
    if (!fs || !stockRoot || !subfolder) return null;
    var dir = stockRoot.replace(/[\/\\]+$/, "") + "\\" + String(subfolder).replace(/\//g, "\\").replace(/^[\\]+|[\\]+$/g, "");
    try {
        if (!fs.existsSync(dir)) { log("Stock: pasta não encontrada: " + dir, "warn"); return null; }
        var files = fs.readdirSync(dir).filter(function (f) {
            return /\.(mp4|mov|avi|mkv|m4v|webm|mpg|mpeg|wmv)$/i.test(f);
        });
        if (!files.length) { log("Stock: nenhum vídeo em " + dir, "warn"); return null; }
        return dir + "\\" + files[Math.floor(Math.random() * files.length)];
    } catch (e) { log("Stock: erro ao listar " + dir + ": " + e.message, "warn"); return null; }
}

// Resolve um caminho relativo do JSON para absoluto usando a pasta raiz.
// Se o arquivo exato não existir mas houver versão com outra extensão de imagem
// (.png/.jpg/.jpeg/.webp), retorna o que existir — assim o JSON pode dizer "1.png"
// mas o disco ter "1.jpeg" e ainda funciona.
function resolvePath(relativePath) {
    var root = getRootFolder();
    if (!root || !relativePath) return relativePath;
    // Normaliza separadores
    var rel = relativePath.replace(/\//g, "\\");
    var fullPath = root + "\\" + rel;

    // Tenta extensões alternativas se o arquivo exato não existir
    var fs = tryNodeRequire('fs');
    if (fs) {
        try {
            if (fs.existsSync(fullPath)) return fullPath;
            // Extrai extensão atual
            var dotIdx = fullPath.lastIndexOf('.');
            if (dotIdx > 0) {
                var base = fullPath.substring(0, dotIdx);
                var ext  = fullPath.substring(dotIdx + 1).toLowerCase();
                // Só tenta variantes pra extensões de imagem conhecidas
                var imgExts = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff'];
                if (imgExts.indexOf(ext) >= 0) {
                    for (var i = 0; i < imgExts.length; i++) {
                        if (imgExts[i] === ext) continue;
                        var candidate = base + '.' + imgExts[i];
                        if (fs.existsSync(candidate)) return candidate;
                        // Tenta também com extensão em maiúsculas (Windows é case-insensitive
                        // mas alguns FS são case-sensitive)
                        var candidateUp = base + '.' + imgExts[i].toUpperCase();
                        if (fs.existsSync(candidateUp)) return candidateUp;
                    }
                }
            }
        } catch(e) { /* ignora */ }
    }
    return fullPath; // devolve o original (vai falhar no Premiere com erro claro)
}

// Lê dimensões (largura, altura) de um arquivo de imagem direto do header binário.
// Suporta PNG, JPEG/JPG, WebP, BMP. Retorna { w, h } ou null se falhar.
// Usado pra computar Scale to Frame Size sem depender de XMP metadata do Premiere.
function getImageDimensions(filePath) {
    var fs = tryNodeRequire('fs');
    if (!fs) return null;
    try {
        if (!fs.existsSync(filePath)) return null;
        // Lê os primeiros 64KB (suficiente pra encontrar dimensões em JPEG)
        var fd = fs.openSync(filePath, 'r');
        var buf = Buffer.alloc(65536);
        var bytesRead = fs.readSync(fd, buf, 0, 65536, 0);
        fs.closeSync(fd);
        if (bytesRead < 8) return null;
        buf = buf.slice(0, bytesRead);

        // PNG: assinatura 89 50 4E 47 0D 0A 1A 0A, depois IHDR a partir do byte 8
        // IHDR começa com length (4b) + "IHDR" (4b) + width (4b BE) + height (4b BE)
        if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
            if (bytesRead >= 24) {
                var w = buf.readUInt32BE(16);
                var h = buf.readUInt32BE(20);
                return { w: w, h: h };
            }
        }

        // JPEG: começa com FF D8, depois marcadores. Procura SOF0/SOF2 (FF C0/C2)
        if (buf[0] === 0xFF && buf[1] === 0xD8) {
            var i = 2;
            while (i < bytesRead - 9) {
                if (buf[i] !== 0xFF) { i++; continue; }
                var marker = buf[i + 1];
                // SOF0(C0), SOF1(C1), SOF2(C2), SOF3(C3) - frame headers com dimensões
                if (marker === 0xC0 || marker === 0xC1 || marker === 0xC2 || marker === 0xC3) {
                    // Segment: FF Cx (2) + length(2) + precision(1) + height(2 BE) + width(2 BE)
                    var h2 = buf.readUInt16BE(i + 5);
                    var w2 = buf.readUInt16BE(i + 7);
                    return { w: w2, h: h2 };
                }
                // Skip other marker: FF xx + length(2)
                if (marker === 0xD8 || marker === 0xD9 || (marker >= 0xD0 && marker <= 0xD7)) {
                    i += 2;
                } else {
                    var segLen = buf.readUInt16BE(i + 2);
                    i += 2 + segLen;
                }
            }
        }

        // WebP: "RIFF" + size + "WEBP" + chunks. Pode ser VP8 / VP8L / VP8X
        if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
            buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
            // VP8X chunk em byte 12: "VP8X" + size(4) + flags(4) + canvasW-1(3 LE) + canvasH-1(3 LE)
            if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x58) {
                var wW = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
                var wH = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
                return { w: wW, h: wH };
            }
            // VP8 (lossy): "VP8 " + size(4) + ... width/height a partir do offset 26
            if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x20) {
                var vw = (buf[26] | (buf[27] << 8)) & 0x3FFF;
                var vh = (buf[28] | (buf[29] << 8)) & 0x3FFF;
                return { w: vw, h: vh };
            }
            // VP8L (lossless): "VP8L" + size(4) + signature(1) + bits
            if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x4C) {
                var b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
                var lw = 1 + (((b1 & 0x3F) << 8) | b0);
                var lh = 1 + (((b3 & 0x0F) << 10) | (b2 << 2) | ((b1 & 0xC0) >> 6));
                return { w: lw, h: lh };
            }
        }

        // BMP: "BM" + headers, dimensões em byte 18 (w) e 22 (h) LE
        if (buf[0] === 0x42 && buf[1] === 0x4D && bytesRead >= 26) {
            var bw = buf.readInt32LE(18);
            var bh = Math.abs(buf.readInt32LE(22));
            return { w: bw, h: bh };
        }

        return null;
    } catch(e) { return null; }
}

// ─── MONTAR ───────────────────────────────────────────────────────────────────

function initMontar() {
    var btnStock = document.getElementById("btn-browse-stock");
    if (btnStock) btnStock.addEventListener("click", browseStockFolder);
    var stockInput = document.getElementById("stock-folder");
    if (stockInput) stockInput.addEventListener("change", function () {
        setStockFolder(this.value.trim());
    });
    document.getElementById("btn-load-json").addEventListener("click", openJSONPicker);
    document.getElementById("btn-load-srt").addEventListener("click",  openSRTPicker);
    document.getElementById("btn-load-from-folder").addEventListener("click", loadJSONsFromProjectFolder);
    document.getElementById("btn-mount").addEventListener("click", mountVideo);
}

// ─── RECURSOS (setup: bins de produto + sequências de template) ───────────────

var TEMPLATE_SEQ_NAMES = [
    "[TEMPLATE]PRODUTO",
    "[TEMPLATE]PRECO",
    "[TEMPLATE]LOWERTHIRD",
    "[TEMPLATE]TRANSICAO_1",
    "[TEMPLATE]TRANSICAO_2",
    "[TEMPLATE]LIKE"
];

var REC_IMG_EXTS = ["png", "jpg", "jpeg", "gif", "bmp", "tif", "tiff", "webp"];

// Card pendente: só 1 por vez (evita corrida na numeração de PROD_N).
var _pendingProductCard = null;

function recLog(msg, type) {
    var box = document.getElementById("rec-log");
    if (!box) return;
    var line = document.createElement("div");
    line.className = "log-line " + (type || "info");
    line.textContent = msg;
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
}
function clearRecLog() {
    var box = document.getElementById("rec-log");
    if (box) box.innerHTML = "";
}
function copyRecLog() {
    var lines = document.querySelectorAll("#rec-log .log-line");
    var text  = Array.prototype.map.call(lines, function (l) { return l.textContent; }).join("\n");
    if (!text) { recLog("Status está vazio.", "warn"); return; }
    var ta = document.createElement("textarea");
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.value = text;
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) {}
    document.body.removeChild(ta);
    recLog(ok ? "Status copiado." : "Falha ao copiar (selecione e use Ctrl+C).", ok ? "ok" : "warn");
}

function initRecursos() {
    var addBtn = document.getElementById("btn-add-product");
    if (addBtn) addBtn.addEventListener("click", startNewProductCard);

    // Importação do Google Drive: lembra a API key e dispara a importação.
    var driveKeyEl = document.getElementById("drive-apikey");
    if (driveKeyEl) {
        try { driveKeyEl.value = localStorage.getItem(DRIVE_KEY_STORAGE) || ""; } catch (e) {}
        driveKeyEl.addEventListener("change", function () { try { localStorage.setItem(DRIVE_KEY_STORAGE, driveKeyEl.value.trim()); } catch (e) {} });
    }
    var driveBtn = document.getElementById("btn-drive-import");
    if (driveBtn) driveBtn.addEventListener("click", function () {
        var k = ((document.getElementById("drive-apikey") || {}).value || "").trim();
        var f = ((document.getElementById("drive-folder") || {}).value || "").trim();
        try { localStorage.setItem(DRIVE_KEY_STORAGE, k); } catch (e) {}
        importProductsFromDrive(k, f, function (num, opts) {
            renderProductCard(num, { driveStaged: true, stagedFiles: opts.stagedFiles, refPath: opts.refPath, videoLinks: opts.videoLinks });
        });
    });
    var tplBtn = document.getElementById("btn-create-templates");
    if (tplBtn) tplBtn.addEventListener("click", createTemplateSequencesAction);
    refreshTemplateSeqSection();

    var updBtn = document.getElementById("btn-ytdlp-update");
    if (updBtn) updBtn.addEventListener("click", updateYtDlpAction);
    checkYtDlpUpdate();
}

// Verifica se há atualização do yt-dlp comparando a versão embutida com a
// release mais recente do canal nightly. Mostra a barra de update SÓ se houver
// diferença (= update real disponível).
function checkYtDlpUpdate() {
    var bar = document.getElementById("ytdlp-update-bar");
    var msg = document.getElementById("ytdlp-update-msg");
    if (!bar) return;
    bar.style.display = "none"; // padrão: escondida (mostra só se confirmar update)
    var extDir = getExtensionRootClient();
    var fs    = tryNodeRequire('fs');
    var pmod  = tryNodeRequire('path');
    var cp    = tryNodeRequire('child_process');
    var https = tryNodeRequire('https');
    if (!extDir || !fs || !pmod || !cp || !https) return;
    var ytdlp = pmod.join(extDir, "bin", "yt-dlp.exe");
    if (!fs.existsSync(ytdlp)) return;

    // 1) Versão local
    var bv = "";
    var localProc;
    try { localProc = cp.spawn(ytdlp, ["--version"], { windowsHide: true }); }
    catch (e) { return; }
    localProc.stdout.on("data", function (d) { bv += d.toString(); });
    localProc.on("error", function () {});
    localProc.on("close", function () {
        var bundled = (bv || "").trim();
        if (!bundled) return;
        // 2) Última versão do canal nightly via GitHub API
        var req;
        try {
            req = https.request({
                hostname: "api.github.com",
                path: "/repos/yt-dlp/yt-dlp-nightly-builds/releases/latest",
                method: "GET",
                headers: { "User-Agent": "AutoEditorPPRO" }
            }, function (res) {
                var data = "";
                res.on("data", function (d) { data += d.toString(); });
                res.on("end", function () {
                    try {
                        var r = JSON.parse(data);
                        var latest = String(r.tag_name || "").trim();
                        if (latest && latest !== bundled) {
                            if (msg) msg.textContent = "Atualização do yt-dlp disponível: " + bundled + " → " + latest;
                            bar.style.display = "";
                        }
                    } catch (e) {}
                });
            });
            req.on("error", function () {});
            req.end();
        } catch (e2) {}
    });
}

function updateYtDlpAction() {
    var bar = document.getElementById("ytdlp-update-bar");
    var btn = document.getElementById("btn-ytdlp-update");
    var extDir = getExtensionRootClient();
    var pmod   = tryNodeRequire('path');
    var cp     = tryNodeRequire('child_process');
    if (!extDir || !pmod || !cp) { recLog("Node indisponível pra atualizar.", "err"); return; }
    var ytdlp = pmod.join(extDir, "bin", "yt-dlp.exe");
    if (btn) { btn.disabled = true; btn.textContent = "Atualizando…"; }
    recLog("Atualizando yt-dlp (canal nightly)…");
    var ch;
    try { ch = cp.spawn(ytdlp, ["-U", "--update-to", "nightly"], { windowsHide: true }); }
    catch (e) {
        recLog("✗ Falha ao iniciar update: " + e.message, "err");
        if (btn) { btn.disabled = false; btn.textContent = "Atualizar yt-dlp"; }
        return;
    }
    ch.stdout.on("data", function (d) {
        String(d).split(/\r?\n/).forEach(function (l) { if (l.trim()) recLog("  " + l.trim()); });
    });
    ch.stderr.on("data", function (d) {
        String(d).split(/\r?\n/).forEach(function (l) { if (l.trim()) recLog("  " + l.trim(), "warn"); });
    });
    ch.on("error", function (e) {
        recLog("✗ Erro: " + e.message, "err");
        if (btn) { btn.disabled = false; btn.textContent = "Atualizar yt-dlp"; }
    });
    ch.on("close", function (code) {
        if (code === 0) {
            recLog("✓ yt-dlp atualizado.", "ok");
            // Re-checa: se realmente atualizou, a barra some sozinha.
            setTimeout(checkYtDlpUpdate, 500);
        } else {
            recLog("✗ Update encerrou com código " + code, "err");
        }
        if (btn) { btn.disabled = false; btn.textContent = "Atualizar yt-dlp"; }
    });
}

// ─── AUTO-UPDATE DO PLUGIN (GitHub) ───────────────────────────────────────────
// Sistema de atualização inteligente: na abertura do painel, consulta a GitHub
// API e baixa SÓ os arquivos modificados desde a versão local. Banner azul no
// topo do painel avisa quando há update. Pré-requisito: repo deve ser PÚBLICO
// (não usa autenticação). Versão local armazenada em <extDir>/version.txt.

var UPDATE_REPO_OWNER = "felipoliver15-hash";
var UPDATE_REPO_NAME  = "AutoEditorPPRO";
var UPDATE_BRANCH     = "main";
var _pendingPluginUpdate = null;

function _versionFilePath() {
    var pmod = tryNodeRequire('path');
    var extDir = getExtensionRootClient();
    if (!pmod || !extDir) return null;
    return pmod.join(extDir, "version.txt");
}
function _readLocalVersion() {
    var fs = tryNodeRequire('fs');
    var p = _versionFilePath();
    if (!fs || !p) return null;
    try { if (fs.existsSync(p)) return String(fs.readFileSync(p, 'utf8') || "").trim(); } catch (e) {}
    return null;
}
function _writeLocalVersion(sha) {
    var fs = tryNodeRequire('fs');
    var p = _versionFilePath();
    if (!fs || !p) return false;
    try { fs.writeFileSync(p, String(sha), 'utf8'); return true; } catch (e) { return false; }
}

// HTTPS GET genérico com suporte a redirect e cabeçalho User-Agent (GitHub exige).
function _httpsGet(url, asBinary, cb, _depth) {
    if (_depth === undefined) _depth = 0;
    if (_depth > 5) { cb(new Error("muitos redirects")); return; }
    var https = tryNodeRequire('https');
    if (!https) { cb(new Error("https indisponível")); return; }
    var m = url.match(/^https?:\/\/([^\/]+)(\/.*)?$/);
    if (!m) { cb(new Error("URL inválida: " + url)); return; }
    var hostname = m[1], path = m[2] || "/";
    var headers = { "User-Agent": "AutoEditorPPRO" };
    if (!asBinary) headers["Accept"] = "application/vnd.github+json";
    var req;
    try {
        req = https.request({ hostname: hostname, path: path, method: "GET", headers: headers }, function (res) {
            if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) && res.headers.location) {
                return _httpsGet(res.headers.location, asBinary, cb, _depth + 1);
            }
            if (res.statusCode >= 400) {
                cb(new Error("HTTP " + res.statusCode + " " + url));
                return;
            }
            if (asBinary) {
                var chunks = [];
                res.on("data", function (d) { chunks.push(d); });
                res.on("end", function () { cb(null, Buffer.concat(chunks)); });
            } else {
                var data = "";
                res.on("data", function (d) { data += d.toString(); });
                res.on("end", function () {
                    try { cb(null, JSON.parse(data)); } catch (e) { cb(new Error("JSON inválido: " + e.message + " — " + data.substring(0, 100))); }
                });
            }
        });
        req.on("error", function (e) { cb(e); });
        req.end();
    } catch (e) { cb(e); }
}

// Checa updates. Se verbose=true, loga feedback em rec-log (botão manual).
// Se verbose=false, silencioso (auto-check na inicialização).
function checkPluginUpdate(verbose) {
    var bar = document.getElementById("plugin-update-bar");
    if (!bar) return;
    bar.style.display = "none";
    var fs = tryNodeRequire('fs'); var pmod = tryNodeRequire('path');
    if (!fs || !pmod) {
        if (verbose) recLog("Node indisponível — sem como verificar.", "err");
        return;
    }
    if (verbose) recLog("Verificando atualizações do plugin no GitHub…");
    var apiUrl = "https://api.github.com/repos/" + UPDATE_REPO_OWNER + "/" + UPDATE_REPO_NAME + "/commits/" + UPDATE_BRANCH;
    _httpsGet(apiUrl, false, function (err, data) {
        if (err || !data || !data.sha) {
            if (verbose) recLog("✗ Erro ao verificar: " + (err ? err.message : "resposta inválida"), "err");
            return;
        }
        var remoteSha = data.sha;
        var short = remoteSha.substring(0, 7);
        var local = _readLocalVersion();
        if (!local) {
            // Primeira execução: assume install = última versão e salva o SHA.
            _writeLocalVersion(remoteSha);
            if (verbose) recLog("✓ Versão atual definida como " + short + " (primeira verificação).", "ok");
            return;
        }
        if (local === remoteSha) {
            if (verbose) recLog("✓ Plugin atualizado (commit " + short + ")", "ok");
            return;
        }
        // Pega lista de arquivos modificados entre local e remoto.
        var cmpUrl = "https://api.github.com/repos/" + UPDATE_REPO_OWNER + "/" + UPDATE_REPO_NAME + "/compare/" + local + "..." + remoteSha;
        _httpsGet(cmpUrl, false, function (err2, cmp) {
            if (err2) {
                _pendingPluginUpdate = { localSha: local, remoteSha: remoteSha, files: [], full: true };
                _showUpdateBanner("Versão local antiga não pôde ser comparada — recomenda-se reinstalar.");
                if (verbose) recLog("⚠ Versão local não pôde ser comparada — talvez force-push? Reinstale.", "warn");
                return;
            }
            var files = cmp && cmp.files ? cmp.files : [];
            if (!files.length) {
                _writeLocalVersion(remoteSha);
                if (verbose) recLog("✓ Plugin atualizado (commit " + short + ")", "ok");
                return;
            }
            _pendingPluginUpdate = { localSha: local, remoteSha: remoteSha, files: files, full: false };
            var subj = (data.commit && data.commit.message ? data.commit.message.split("\n")[0] : "").substring(0, 60);
            _showUpdateBanner("Atualização disponível: " + files.length + " arquivo(s) — " + subj);
            if (verbose) recLog("⚠ Update disponível: " + files.length + " arquivo(s) (" + local.substring(0, 7) + " → " + short + ") — banner azul no topo do painel.", "warn");
        });
    });
}

function _showUpdateBanner(msg) {
    var bar = document.getElementById("plugin-update-bar");
    var msgEl = document.getElementById("plugin-update-msg");
    if (!bar) return;
    if (msgEl) msgEl.textContent = msg;
    bar.style.display = "";
}

// Aplica o update: baixa cada arquivo modificado via raw.githubusercontent.com
// e escreve em AppData. Atualiza version.txt no final.
function applyPluginUpdate() {
    if (!_pendingPluginUpdate) return;
    var info = _pendingPluginUpdate;
    if (info.full) {
        _setUpdateMsg("Reinstale manualmente (run install.bat após git pull).");
        return;
    }
    var fs = tryNodeRequire('fs'); var pmod = tryNodeRequire('path');
    var extDir = getExtensionRootClient();
    if (!fs || !pmod || !extDir) { _setUpdateMsg("Erro: Node/extensão indisponível."); return; }

    var btn = document.getElementById("btn-plugin-update");
    if (btn) btn.disabled = true;

    var total = info.files.length, errors = 0;
    function step(i) {
        if (i >= total) {
            if (errors === 0) {
                _writeLocalVersion(info.remoteSha);
                _setUpdateMsg("✓ Atualizado! Feche e reabra o painel pra aplicar.");
            } else {
                _setUpdateMsg("⚠ Update parcial: " + errors + " falha(s). Feche e reabra mesmo assim.");
            }
            if (btn) btn.style.display = "none";
            return;
        }
        var f = info.files[i];
        _setUpdateMsg("Atualizando " + (i + 1) + "/" + total + ": " + f.filename);
        var destPath = pmod.join(extDir, f.filename.replace(/\//g, pmod.sep));

        if (f.status === "removed") {
            try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); }
            catch (eDel) { errors++; }
            return step(i + 1);
        }
        if (f.status === "renamed" && f.previous_filename) {
            // Apaga o antigo e baixa o novo
            try {
                var oldPath = pmod.join(extDir, f.previous_filename.replace(/\//g, pmod.sep));
                if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
            } catch (eOld) {}
        }
        var rawUrl = "https://raw.githubusercontent.com/" + UPDATE_REPO_OWNER + "/" + UPDATE_REPO_NAME + "/" + info.remoteSha + "/" + f.filename;
        _httpsGet(rawUrl, true, function (err, buf) {
            if (err) { errors++; return step(i + 1); }
            try {
                fs.mkdirSync(pmod.dirname(destPath), { recursive: true });
                fs.writeFileSync(destPath, buf);
            } catch (eW) { errors++; }
            step(i + 1);
        });
    }
    step(0);
}

function _setUpdateMsg(msg) {
    var el = document.getElementById("plugin-update-msg");
    if (el) el.textContent = msg;
}

function initPluginUpdate() {
    var btn = document.getElementById("btn-plugin-update");
    if (btn) btn.addEventListener("click", applyPluginUpdate);
    var dis = document.getElementById("btn-plugin-update-dismiss");
    if (dis) dis.addEventListener("click", function () {
        var bar = document.getElementById("plugin-update-bar");
        if (bar) bar.style.display = "none";
    });
    // Botão "Verificar Updates Agora" (manual) — feedback explícito no rec-log.
    var checkBtn = document.getElementById("btn-plugin-check");
    if (checkBtn) checkBtn.addEventListener("click", function () { checkPluginUpdate(true); });
    // Auto-check silencioso na abertura do painel.
    setTimeout(function () { checkPluginUpdate(false); }, 1500);
}

// Mostra a seção "Sequências de template" SÓ se houver alguma faltando.
// Atualiza o hint pra listar exatamente as que faltam.
function refreshTemplateSeqSection() {
    var section = document.getElementById("tpl-section");
    var listEl  = document.getElementById("tpl-missing-list");
    if (!section) return;
    var arg = JSON.stringify(JSON.stringify(TEMPLATE_SEQ_NAMES));
    cs.evalScript("checkTemplateSequences(" + arg + ")", function (raw) {
        var r = { missing: [] };
        try { r = JSON.parse(raw); } catch (e) {}
        var miss = (r && r.missing) || [];
        if (!miss.length) {
            section.style.display = "none";
            return;
        }
        section.style.display = "";
        if (listEl) {
            listEl.innerHTML = miss.map(function (nm) { return '<code>' + nm + '</code>'; }).join(", ");
        }
    });
}

// ─── BAIXAR DO YOUTUBE ────────────────────────────────────────────────────────

// Caminho raiz da extensão (onde fica bin/yt-dlp.exe) — via CSInterface.
// SystemPath.EXTENSION é a forma oficial e confiável; $.fileName no host
// retorna vazio quando chamado via evalScript, por isso evitamos lá.
function getExtensionRootClient() {
    try {
        if (typeof SystemPath !== "undefined" && SystemPath.EXTENSION) {
            return cs.getSystemPath(SystemPath.EXTENSION) || "";
        }
    } catch (e) {}
    try { return cs.getSystemPath("extension") || ""; } catch (e) {}
    return "";
}

// Detecta o ffmpeg. Tenta primeiro o EMBUTIDO (bin/ffmpeg.exe da extensão);
// se não existir, tenta o do PATH. Retorna {ok, location, dir}:
//   - location: caminho ou "ffmpeg" (PATH)
//   - dir: pasta do executável (passada ao yt-dlp via --ffmpeg-location) ou null
function detectFfmpeg(cb) {
    var fs   = tryNodeRequire('fs');
    var pmod = tryNodeRequire('path');
    var extDir = getExtensionRootClient();
    if (fs && pmod && extDir) {
        try {
            var binDir = pmod.join(extDir, "bin");
            var embedded = pmod.join(binDir, "ffmpeg.exe");
            if (fs.existsSync(embedded)) {
                cb({ ok: true, location: embedded, dir: binDir });
                return;
            }
        } catch (e) {}
    }
    var cp = tryNodeRequire('child_process');
    if (!cp) { cb({ ok: false, location: null, dir: null }); return; }
    var done = false;
    try {
        var p = cp.spawn("ffmpeg", ["-version"], { windowsHide: true });
        p.on("error", function () { if (!done) { done = true; cb({ ok: false, location: null, dir: null }); } });
        p.on("close", function (code) {
            if (!done) {
                done = true;
                if (code === 0) cb({ ok: true, location: "ffmpeg", dir: null });
                else cb({ ok: false, location: null, dir: null });
            }
        });
    } catch (e) { cb({ ok: false, location: null, dir: null }); }
}

// Baixa um vídeo do YouTube pra <projDir>/AutoEditor_Downloads/PROD_<folder>/.
// NÃO importa pro bin — entrega o caminho final via onDone(err, filePath).
// onProgress(text) é chamado durante o download (texto pra UI da barra).
// Usado pela barrinha "Baixar do YouTube" dentro do card de Adicionar Produto.
function downloadYTToFolder(folder, url, onProgress, onDone, chooser) {
    if (!url) { onDone(new Error("Cole uma URL primeiro.")); return; }
    var extDir = getExtensionRootClient();
    cs.evalScript("getProjectDir()", function (rawPrj) {
        var prjDir = "";
        try { var rp = JSON.parse(rawPrj); prjDir = rp.dir || ""; } catch (e) {}
        if (!prjDir) {
            onDone(new Error("Salve o projeto antes (a pasta AutoEditor_Downloads vai ao lado do .prproj)."));
            return;
        }

        var host = "";
        try { host = ((String(url).match(/^https?:\/\/([^\/?#]+)/i) || [])[1] || "").toLowerCase(); } catch (e) {}
        var isAmazon = /(^|\.)amazon\./.test(host);

        // Só a Amazon agrupa vários vídeos numa "playlist" de produto (oficiais +
        // relacionados). Para esses links, sonda primeiro: se houver mais de um
        // vídeo, abre o seletor pro usuário escolher quais baixar. YouTube e os
        // demais seguem direto (1 vídeo), sem o custo extra da sondagem.
        if (isAmazon && typeof chooser === "function") {
            if (typeof onProgress === "function") onProgress("analisando link…");
            probePlaylist(url, extDir, function (info) {
                if (info && info.count > 1) {
                    chooser(info.entries, function (selected) {
                        if (!selected || !selected.length) {
                            recLog("Seleção cancelada — nada baixado.", "warn");
                            onDone(null, []); // [] = nenhum arquivo (consumidores ignoram)
                            return;
                        }
                        runYtDlp(url, folder, extDir, prjDir, onProgress, onDone, selected.join(","));
                    });
                } else {
                    runYtDlp(url, folder, extDir, prjDir, onProgress, onDone, "1");
                }
            });
        } else {
            runYtDlp(url, folder, extDir, prjDir, onProgress, onDone, "1");
        }
    });
}

// Sonda um link rapidamente (--flat-playlist) e devolve
// {count, entries:[{index,title,duration,thumbnail}]}. Devolve null se a
// sondagem falhar (aí o chamador baixa normalmente o 1º item).
function probePlaylist(url, extDir, cb) {
    var cp = tryNodeRequire('child_process'), fs = tryNodeRequire('fs'), pmod = tryNodeRequire('path');
    if (!cp) { cb(null); return; }
    var bundled = extDir ? pmod.join(extDir, "bin", "yt-dlp.exe") : "";
    var ytdlp; try { ytdlp = (bundled && fs.existsSync(bundled)) ? bundled : "yt-dlp"; } catch (e) { ytdlp = "yt-dlp"; }
    var spawnEnv = {}; try { Object.keys(process.env || {}).forEach(function (k) { spawnEnv[k] = process.env[k]; }); } catch (e) {}
    spawnEnv.PYTHONIOENCODING = "utf-8";
    var args = ["--flat-playlist", "--dump-single-json", "--no-warnings", url];
    var out = "", ch;
    try { ch = cp.spawn(ytdlp, args, { windowsHide: true, env: spawnEnv }); }
    catch (e) { cb(null); return; }
    try { ch.stdout.setEncoding("utf8"); ch.stderr.setEncoding("utf8"); } catch (e) {}
    ch.stdout.on("data", function (d) { out += d.toString(); });
    ch.on("error", function () { cb(null); });
    ch.on("close", function () {
        var j; try { j = JSON.parse(out); } catch (e) { cb(null); return; }
        if (j && j.entries && j.entries.length) {
            var entries = [];
            for (var i = 0; i < j.entries.length; i++) {
                var e = j.entries[i] || {};
                entries.push({
                    index: e.playlist_index || (i + 1),
                    title: e.title || ("Vídeo " + (i + 1)),
                    duration: e.duration || 0,
                    thumbnail: e.thumbnail || ""
                });
            }
            cb({ count: entries.length, entries: entries });
        } else {
            cb({ count: 1, entries: [] });
        }
    });
}

// Modal de seleção (quando um link tem mais de um vídeo). Chama
// onChoose(arrayDeIndices 1-based) com o que foi marcado, ou onChoose(null) ao cancelar.
function chooseVideosModal(entries, onChoose) {
    function fmtDur(s) { s = Math.round(s || 0); if (!s) return ""; var m = Math.floor(s / 60), ss = s % 60; return m + ":" + (ss < 10 ? "0" : "") + ss; }
    var done = false;
    function finish(sel) { if (done) return; done = true; try { document.body.removeChild(overlay); } catch (e) {} onChoose(sel); }

    var overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.6);z-index:9999;display:flex;align-items:center;justify-content:center";

    var box = document.createElement("div");
    box.style.cssText = "background:#2a2a2a;border:1px solid #555;border-radius:8px;width:92%;max-width:520px;max-height:86%;display:flex;flex-direction:column;box-shadow:0 8px 30px rgba(0,0,0,.5)";
    overlay.appendChild(box);

    var head = document.createElement("div");
    head.style.cssText = "padding:12px 14px;border-bottom:1px solid #444;font-weight:bold";
    head.textContent = "Este link tem " + entries.length + " vídeos — escolha quais baixar:";
    box.appendChild(head);

    var tools = document.createElement("div");
    tools.style.cssText = "padding:6px 14px;border-bottom:1px solid #3a3a3a;font-size:12px";
    var aAll = document.createElement("a"); aAll.href = "#"; aAll.textContent = "Marcar todos"; aAll.style.cssText = "color:#9cf;margin-right:12px;text-decoration:none";
    var aNone = document.createElement("a"); aNone.href = "#"; aNone.textContent = "Desmarcar todos"; aNone.style.cssText = "color:#9cf;text-decoration:none";
    tools.appendChild(aAll); tools.appendChild(aNone);
    box.appendChild(tools);

    var list = document.createElement("div");
    list.style.cssText = "overflow-y:auto;padding:6px 10px;flex:1";
    box.appendChild(list);

    var checks = [];
    entries.forEach(function (e) {
        var row = document.createElement("label");
        row.style.cssText = "display:flex;align-items:center;gap:8px;padding:6px;border-bottom:1px solid #333;cursor:pointer";
        var cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = true; cb.value = e.index;
        checks.push(cb);
        var thumbBox = document.createElement("div");
        thumbBox.style.cssText = "width:64px;height:40px;flex:0 0 64px;background:#111;border-radius:3px;overflow:hidden;display:flex;align-items:center;justify-content:center;font-size:10px;color:#666";
        if (e.thumbnail) {
            var img = document.createElement("img");
            img.src = e.thumbnail; img.style.cssText = "width:100%;height:100%;object-fit:cover";
            img.onerror = function () { try { thumbBox.removeChild(img); } catch (x) {} thumbBox.textContent = "▶"; };
            thumbBox.appendChild(img);
        } else { thumbBox.textContent = "▶"; }
        var info = document.createElement("div");
        info.style.cssText = "flex:1;min-width:0";
        var t = document.createElement("div"); t.textContent = e.title; t.style.cssText = "white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
        var d = document.createElement("div"); d.textContent = fmtDur(e.duration); d.style.cssText = "font-size:11px;color:#888";
        info.appendChild(t); info.appendChild(d);
        row.appendChild(cb); row.appendChild(thumbBox); row.appendChild(info);
        list.appendChild(row);
    });

    var foot = document.createElement("div");
    foot.style.cssText = "padding:10px 14px;border-top:1px solid #444;display:flex;gap:8px;justify-content:flex-end";
    var cancelB = document.createElement("button"); cancelB.textContent = "Cancelar";
    var okB = document.createElement("button"); okB.className = "btn-primary";
    foot.appendChild(cancelB); foot.appendChild(okB);
    box.appendChild(foot);

    function refreshOk() {
        var n = checks.filter(function (c) { return c.checked; }).length;
        okB.textContent = "Baixar selecionados (" + n + ")";
        okB.disabled = (n === 0);
    }
    aAll.onclick = function (ev) { ev.preventDefault(); checks.forEach(function (c) { c.checked = true; }); refreshOk(); };
    aNone.onclick = function (ev) { ev.preventDefault(); checks.forEach(function (c) { c.checked = false; }); refreshOk(); };
    checks.forEach(function (c) { c.addEventListener("change", refreshOk); });
    cancelB.onclick = function () { finish(null); };
    okB.onclick = function () {
        var sel = checks.filter(function (c) { return c.checked; }).map(function (c) { return parseInt(c.value, 10); });
        finish(sel);
    };
    overlay.addEventListener("click", function (ev) { if (ev.target === overlay) finish(null); });

    refreshOk();
    document.body.appendChild(overlay);
}

// Garante um runtime JS (Deno) pro yt-dlp resolver o desafio do YouTube (nsig).
// Sem ele, vídeos falham com "This video is not available". Ordem:
//   1) deno.exe embutido (baixado antes) → usa.
//   2) deno no PATH → yt-dlp acha sozinho (não precisa flag).
//   3) node no PATH → usa via --js-runtimes node.
//   4) nada → baixa o deno.exe pro bin/ (uma vez).
// Chama cb(jsRuntimeArg) com a string pra --js-runtimes ("deno:<path>"/"node")
// ou null (deixa o yt-dlp auto-detectar / sem runtime).
function ensureJsRuntime(extDir, cb) {
    var fs = tryNodeRequire('fs'), pmod = tryNodeRequire('path'), cp = tryNodeRequire('child_process');
    if (!fs || !pmod) { cb(null); return; }
    var bundledDeno = extDir ? pmod.join(extDir, "bin", "deno.exe") : "";
    try { if (bundledDeno && fs.existsSync(bundledDeno)) { cb("deno:" + bundledDeno); return; } } catch (e) {}

    function onPath(exe) {
        try { var r = cp.spawnSync(exe, ["--version"], { windowsHide: true, timeout: 6000 }); return !!(r && r.status === 0); }
        catch (e) { return false; }
    }
    if (onPath("deno")) { cb(null); return; }   // yt-dlp usa o deno do PATH sozinho
    if (onPath("node")) { cb("node"); return; }

    downloadDeno(extDir, function (err, denoPath) {
        if (err || !denoPath) {
            recLog("⚠ Não consegui obter o runtime JS (Deno): " + (err ? err.message : "?") + " — alguns vídeos do YouTube podem falhar.", "warn");
            cb(null); return;
        }
        cb("deno:" + denoPath);
    });
}

// Baixa o deno.exe (release oficial, .zip ~40MB) pro <extDir>/bin/ e extrai com o
// tar do Windows. cb(err, denoPath). Só roda uma vez (depois fica embutido).
function downloadDeno(extDir, cb) {
    var fs = tryNodeRequire('fs'), pmod = tryNodeRequire('path'), cp = tryNodeRequire('child_process');
    if (!fs || !pmod || !cp || !extDir) { cb(new Error("Node indisponível")); return; }
    var binDir = pmod.join(extDir, "bin");
    try { fs.mkdirSync(binDir, { recursive: true }); } catch (e) {}
    var zipPath = pmod.join(binDir, "deno.zip");
    var denoPath = pmod.join(binDir, "deno.exe");
    var url = "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip";
    recLog("Baixando runtime JS (Deno ~40MB, só na primeira vez)…");
    _httpsGet(url, true, function (err, buf) {
        if (err) { cb(err); return; }
        try { fs.writeFileSync(zipPath, buf); } catch (eW) { cb(eW); return; }
        recLog("Extraindo Deno…");
        // Extrai com PowerShell Expand-Archive (sempre presente no Windows e lida
        // com o caminho nativamente). cwd no bin/ + nome relativo evita problema de
        // espaço no caminho (ex: "Local Apps") e o tar interpretando "C:" como host.
        var ch;
        try {
            ch = cp.spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
                "Expand-Archive -Path deno.zip -DestinationPath . -Force"],
                { cwd: binDir, windowsHide: true });
        } catch (eS) { cb(eS); return; }
        ch.on("error", function (e) { cb(e); });
        ch.on("close", function (code) {
            try { fs.unlinkSync(zipPath); } catch (e) {}
            try {
                if (fs.existsSync(denoPath)) { recLog("✓ Deno instalado no plugin (bin/deno.exe).", "ok"); cb(null, denoPath); }
                else { cb(new Error("deno.exe não apareceu após extrair (Expand-Archive saiu " + code + ")")); }
            } catch (eC) { cb(eC); }
        });
    });
}

// Baixa o vídeo via yt-dlp. Entrega o caminho final via onDone(err, path).
// onProgress(text) é chamado a cada 5% pra atualizar a UI (ex: rótulo do botão).
function runYtDlp(url, folder, extDir, prjDir, onProgress, onDone, playlistItems) {
    function fail(msg) { onDone(new Error(msg)); }
    playlistItems = playlistItems || "1";
    // multi = a seleção pega mais de um item (tem vírgula/intervalo, ex "2,4,5"/"1-3").
    var multi = (playlistItems !== String(parseInt(playlistItems, 10)));
    var cp   = tryNodeRequire('child_process');
    var fs   = tryNodeRequire('fs');
    var pmod = tryNodeRequire('path');
    if (!cp || !fs || !pmod) { fail("Node child_process/fs/path indisponíveis."); return; }

    var outDir = pmod.join(prjDir, "AutoEditor_Downloads", "PROD_" + folder);
    try { fs.mkdirSync(outDir, { recursive: true }); }
    catch (e) { fail("Erro criando pasta '" + outDir + "': " + e.message); return; }

    // Limpa arquivos órfãos de execuções anteriores (manifests HLS, .part etc).
    // Se ficar um .m3u8 antigo de um download falho, o yt-dlp tenta usá-lo como
    // input do postprocessor e quebra com "Invalid data found when processing
    // input". Removê-los antes do download evita esse falso-erro.
    try {
        fs.readdirSync(outDir).forEach(function (n) {
            if (/\.(m3u8|part|ytdl|temp)$/i.test(n)) {
                try { fs.unlinkSync(pmod.join(outDir, n)); recLog("  limpando órfão: " + n); } catch (e) {}
            }
        });
    } catch (e) {}

    var bundled = extDir ? pmod.join(extDir, "bin", "yt-dlp.exe") : "";
    var hasBundled = false;
    try { hasBundled = !!(bundled && fs.existsSync(bundled)); } catch (e) {}
    var ytdlp = hasBundled ? bundled : "yt-dlp";

    recLog(hasBundled ? "yt-dlp: embutido" : "yt-dlp: PATH");
    recLog("Baixando → PRODUTO " + folder + " | " + url);
    if (multi) recLog("Itens selecionados: " + playlistItems);

    // YouTube precisa de runtime JS (Deno) pro yt-dlp resolver o desafio (nsig);
    // sem ele dá "This video is not available". Garante o runtime ANTES de baixar
    // (usa deno/node do PATH, ou baixa o deno embutido 1x). Outros sites não precisam.
    var _hostJs = "";
    try { _hostJs = ((String(url).match(/^https?:\/\/([^\/?#]+)/i) || [])[1] || "").toLowerCase(); } catch (eHj) {}
    var _needsJs = (_hostJs.indexOf("youtube.com") >= 0 || _hostJs.indexOf("youtu.be") >= 0);

    function afterRuntime(jsRuntimeArg) {
    detectFfmpeg(function (ff) {
        var formatSel, extraArgs = [];
        if (ff.ok) {
            recLog("ffmpeg: " + (ff.dir ? "embutido" : "PATH") + " — qualidade alta (merge vídeo+áudio).");
            // PRIORIZA H.264 (avc1) + AAC — o Premiere NÃO decodifica VP9/AV1, então
            // "ext=mp4" não basta (YouTube serve av01 em mp4 também → importava só o áudio).
            // Cai pra avc1, depois mp4 sem av01/vp9, e por fim qualquer coisa.
            formatSel = "bestvideo[vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo[vcodec^=avc1]+bestaudio/best[vcodec^=avc1]/bestvideo[ext=mp4][vcodec!*=av01][vcodec!*=vp09][vcodec!*=vp9]+bestaudio[ext=m4a]/best[ext=mp4]/best";
            extraArgs = [
                "--merge-output-format", "mp4",
                // Amazon (e vários outros) servem HLS num único format com codec
                // "unknown" — remux pra mp4 + downloader ffmpeg pra HLS faz a
                // mágica funcionar sem quebrar YouTube (que continua usando o
                // downloader nativo pra DASH).
                "--remux-video", "mp4",
                "--downloader", "m3u8:ffmpeg",
                // NÃO usar --hls-use-mpegts: ele grava o HLS como MPEG-TS dentro de
                // um arquivo .mp4 e, como a extensão já é .mp4, o yt-dlp PULA o remux
                // (só faz remux/merge quando há faixas separadas, ex. Amazon). Em
                // stream único já mesclado (Mercado Livre) sobrava TS cru num .mp4 →
                // o Premiere recusa ("unsupported compression type"). Sem o flag, o
                // downloader m3u8:ffmpeg converte TS→MP4 (tag avc1/mp4a, descarta o
                // stream de dados timed_id3) e o arquivo importa normal.
                // O Premiere/CEP roda SEM console anexado. O ffmpeg (chamado pelo
                // yt-dlp como downloader de HLS) tenta ler o stdin pra tecla [q] e,
                // com handle de stdin inválido, sai com "code 4294967268" (HLS do
                // ML/Amazon não baixava). -nostdin faz o ffmpeg ignorar o stdin.
                "--downloader-args", "ffmpeg:-nostdin"
            ];
            if (ff.dir) extraArgs.push("--ffmpeg-location", ff.dir);
        } else {
            recLog("⚠ ffmpeg não encontrado — caindo pra MP4 progressivo (~360p no YouTube novo).", "warn");
            formatSel = "best[ext=mp4][acodec!=none][vcodec!=none]/best[acodec!=none][vcodec!=none]";
        }

        // Seleção de itens da "playlist" (Amazon trata cada produto como playlist).
        // playlistItems vem do seletor (ex "2,4,5") ou "1" no caso normal.
        // Usamos --playlist-items (e não --no-playlist, que faz a Amazon falhar).
        var selectArgs = ["--playlist-items", playlistItems];
        var jsArgs = jsRuntimeArg ? ["--js-runtimes", jsRuntimeArg] : []; // runtime JS p/ YouTube

        var args = ["-f", formatSel].concat(extraArgs).concat(selectArgs).concat(jsArgs).concat([
            "--restrict-filenames", "--no-warnings",
            "--force-overwrites",
            "-o", pmod.join(outDir, "%(title)s.%(ext)s"),
            "--print", "after_move:%(filepath)s",
            url
        ]);

        var ytFinalPath = "", ytPaths = [], lastPctReported = -1, lastActivityMs = Date.now();
        function processLine(line) {
            var s = line.replace(/\r$/, "").trim();
            if (!s) return;
            var pct = s.match(/\[download\]\s+([\d.]+)%/);
            if (pct) {
                var n = Math.floor(parseFloat(pct[1]) / 5) * 5;
                if (n !== lastPctReported) {
                    recLog("  download " + n + "%");
                    if (typeof onProgress === "function") onProgress("Baixando " + n + "%");
                    lastPctReported = n;
                }
                return;
            }
            // HLS/Amazon: o downloader ffmpeg NÃO emite "[download] %", emite
            // "time=00:00:XX". Sem isto a UI fica muda e PARECE travada (mas baixa).
            var ft = s.match(/\btime=\s*(\d{2}:\d{2}:\d{2})/);
            if (ft) {
                lastActivityMs = Date.now();
                if (typeof onProgress === "function") onProgress("baixando (HLS) " + ft[1]);
                return;
            }
            // Linhas que começam com letra de unidade (C:\, D:\…) e terminam em
            // extensão de vídeo são o --print after_move:%(filepath)s. No modo
            // multi (amazon.com) cada vídeo emite uma; acumula todas.
            if (/^[A-Za-z]:[\\\/]/.test(s) && /\.(mp4|mkv|webm|m4a)$/i.test(s)) {
                if (ytPaths.indexOf(s) < 0) ytPaths.push(s);
                if (!ytFinalPath) ytFinalPath = s;
                return;
            }
            if (/^ERROR\b/i.test(s)) { recLog(s, "err"); return; }
            if (/^WARNING\b/i.test(s)) { recLog(s, "warn"); return; }
        }
        function drain(chunk, sink) {
            lastActivityMs = Date.now();  // qualquer saída = processo vivo (watchdog)
            sink.buf += chunk.toString();
            var idx;
            while ((idx = sink.buf.indexOf("\n")) >= 0) {
                processLine(sink.buf.substring(0, idx));
                sink.buf = sink.buf.substring(idx + 1);
            }
        }
        var outSink = { buf: "" }, errSink = { buf: "" };
        // Janela de tempo válida pra detectar o arquivo final: o fallback de
        // "pega o arquivo mais novo da pasta" SÓ pode considerar arquivos cuja
        // mtime caia depois deste momento (com 2s de folga). Senão ele pega
        // arquivos antigos da pasta (ex: vídeo de outro download) e mente
        // sucesso falsamente.
        var runStartMs = Date.now() - 2000;

        // Força UTF-8 na stdout do yt-dlp (que é Python). Em Windows BR a stdout
        // default é cp1252 — sem isso, paths com acentos chegam aqui como bytes
        // 0xE9 etc., o Node decodifica errado, e o regex de captura do
        // --print after_move:%(filepath)s não bate. Resultado antes do fix:
        // o fallback "arquivo mais novo" era usado quase sempre.
        var spawnEnv = {};
        try { Object.keys(process.env || {}).forEach(function (k) { spawnEnv[k] = process.env[k]; }); } catch (eEnv) {}
        spawnEnv.PYTHONIOENCODING = "utf-8";

        var ch;
        // stdio: ["ignore", ...] dá ao yt-dlp (e ao ffmpeg filho) um stdin NUL
        // VÁLIDO. Sem isso, dentro do Premiere/CEP (processo GUI sem console) o
        // ffmpeg herda um handle de stdin inválido e o download HLS falha com
        // "ffmpeg exited with code 4294967268". Cobre downloader E merge.
        try { ch = cp.spawn(ytdlp, args, { windowsHide: true, env: spawnEnv, stdio: ["ignore", "pipe", "pipe"] }); }
        catch (eSp) { fail("Falha ao iniciar yt-dlp: " + eSp.message); return; }
        try { ch.stdout.setEncoding("utf8"); ch.stderr.setEncoding("utf8"); } catch (eEnc) {}
        ch.stdout.on("data", function (d) { drain(d, outSink); });
        ch.stderr.on("data", function (d) { drain(d, errSink); });

        // Watchdog: se NENHUMA saída por 2 min, considera travado, mata e segue a
        // fila (evita download "preso" pra sempre). Saída ativa reseta lastActivityMs.
        var _killedByWatchdog = false;
        var idleTimer = setInterval(function () {
            if (Date.now() - lastActivityMs > 120000) {
                _killedByWatchdog = true;
                recLog("⏱ Sem progresso por 2 min — abortando este download e seguindo.", "warn");
                try { clearInterval(idleTimer); } catch (eCi) {}
                try { ch.kill(); } catch (eK) {}
            }
        }, 5000);

        ch.on("error", function (e) { try { clearInterval(idleTimer); } catch (eC) {} fail("Erro yt-dlp: " + e.message); });
        ch.on("close", function (code) {
            try { clearInterval(idleTimer); } catch (eC) {}
            if (_killedByWatchdog) { fail("download abortado (sem progresso por 2 min)"); return; }
            if (outSink.buf) processLine(outSink.buf);
            if (errSink.buf) processLine(errSink.buf);
            if (code !== 0) { fail("yt-dlp encerrou com código " + code); return; }
            // Valida os caminhos coletados via --print (remove inexistentes).
            ytPaths = ytPaths.filter(function (p) { try { return fs.existsSync(p); } catch (e) { return false; } });

            // Fallback: se nada veio via --print, pega o(s) arquivo(s) criado(s)
            // nesta execução — no modo multi, todos; senão, o mais novo.
            if (!ytPaths.length) {
                try {
                    var entries = fs.readdirSync(outDir).map(function (n) {
                        var p = pmod.join(outDir, n);
                        var st = fs.statSync(p);
                        return { p: p, m: st.mtimeMs, isFile: st.isFile() };
                    }).filter(function (e) {
                        return e.isFile
                            && e.m >= runStartMs   // SÓ arquivos modificados nesta execução
                            && /\.(mp4|mkv|webm|m4a)$/i.test(e.p);
                    });
                    entries.sort(function (a, b) { return b.m - a.m; });
                    if (entries.length) {
                        ytPaths = multi
                            ? entries.map(function (e) { return e.p; })
                            : [entries[0].p];
                        recLog("⚠ Caminho final não veio via --print, usando arquivo(s) novo(s) da pasta.", "warn");
                    }
                } catch (eF) {}
            }
            if (!ytPaths.length) { fail("Download terminou (exit 0) mas nenhum arquivo novo foi criado — provavelmente o extractor falhou silenciosamente."); return; }
            recLog("✓ Baixado(s): " + ytPaths.length + " arquivo(s).", "ok");
            ytPaths.forEach(function (p) { recLog("   • " + p, "ok"); });
            // No modo multi entrega o array inteiro; senão, o caminho único (compat).
            onDone(null, multi ? ytPaths : ytPaths[0]);
        });
    });
    } // fim afterRuntime

    if (_needsJs) ensureJsRuntime(extDir, afterRuntime);
    else afterRuntime(null);
}

function recIsImage(path) {
    var m = String(path).toLowerCase().match(/\.([a-z0-9]+)$/);
    return !!(m && REC_IMG_EXTS.indexOf(m[1]) >= 0);
}
function recBaseName(path) {
    return String(path).replace(/[\\\/]+$/, "").split(/[\\\/]/).pop();
}

// ─── IMPORTAÇÃO DO GOOGLE DRIVE ───────────────────────────────────────────────
// A automação do usuário sobe, numa pasta-mãe do Drive, subpastas "N - Nome"
// com as imagens e um .txt de links de vídeo. Aqui o plugin lê essa pasta-mãe e,
// pra cada subpasta, baixa as imagens/o .txt, popula o staging de um card de
// produto PROD_N (pré-marcando o .png como referência) e enfileira os vídeos.
// Acesso: API key do Google (Drive API) + pasta compartilhada "qualquer um c/ link".
var DRIVE_KEY_STORAGE = "autoeditor_drive_apikey";

// Extrai o ID da pasta de um link do Drive ou aceita o ID puro.
function _driveExtractFolderId(input) {
    var s = String(input || "").trim();
    var m = s.match(/\/folders\/([A-Za-z0-9_-]+)/) || s.match(/[?&]id=([A-Za-z0-9_-]+)/);
    if (m) return m[1];
    if (/^[A-Za-z0-9_-]{12,}$/.test(s)) return s; // já é o ID
    return "";
}

// Lista os filhos (arquivos/subpastas) de uma pasta do Drive. cb(err, [{id,name,mimeType,size}]).
function _driveList(apiKey, folderId, cb) {
    var q = encodeURIComponent("'" + folderId + "' in parents and trashed=false");
    var fields = encodeURIComponent("files(id,name,mimeType,size)");
    var url = "https://www.googleapis.com/drive/v3/files?q=" + q +
              "&key=" + encodeURIComponent(apiKey) +
              "&fields=" + fields +
              "&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true";
    _httpsGet(url, false, function (err, data) {
        if (err) { cb(err); return; }
        cb(null, (data && data.files) || []);
    });
}

// Baixa um arquivo do Drive (alt=media) pra destPath. cb(err, destPath).
function _driveDownload(apiKey, fileId, destPath, cb) {
    var url = "https://www.googleapis.com/drive/v3/files/" + fileId +
              "?alt=media&supportsAllDrives=true&key=" + encodeURIComponent(apiKey);
    _httpsGet(url, true, function (err, buf) {
        if (err) { cb(err); return; }
        try { tryNodeRequire('fs').writeFileSync(destPath, buf); cb(null, destPath); }
        catch (e) { cb(e); }
    });
}

// Extrai 1 link http(s) por linha de um texto (mesma regra do readLinksFromTxt do card).
function _extractLinksFromText(content) {
    var out = [];
    String(content || "").split(/\r?\n/).forEach(function (line) {
        var m = String(line).match(/https?:\/\/\S+/);
        if (m) out.push(m[0]);
    });
    return out;
}

// Orquestra a importação: lê a pasta-mãe, acha as subpastas "N - Nome" e importa
// cada produto em fila. renderCb(num, {stagedFiles, refPath, videoLinks}) cria o card.
function importProductsFromDrive(apiKey, folderInput, renderCb) {
    var fs = tryNodeRequire('fs'), pmod = tryNodeRequire('path');
    if (!fs || !pmod) { recLog("Node indisponível.", "err"); return; }
    if (!apiKey) { recLog("Cole a API key do Drive primeiro.", "err"); return; }
    var folderId = _driveExtractFolderId(folderInput);
    if (!folderId) { recLog("Link/ID da pasta inválido.", "err"); return; }

    cs.evalScript("getProjectDir()", function (rawPrj) {
        var prjDir = ""; try { prjDir = (JSON.parse(rawPrj) || {}).dir || ""; } catch (e) {}
        if (!prjDir) { recLog("Salve o projeto antes (as imagens/vídeos vão pra pasta ao lado do .prproj).", "err"); return; }

        recLog("Drive: listando subpastas…");
        _driveList(apiKey, folderId, function (err, children) {
            if (err) { recLog("✗ Drive: " + err.message + " (a pasta está compartilhada por link? a API key tem a Drive API ativada?)", "err"); return; }
            var subs = [];
            children.forEach(function (c) {
                if (c.mimeType !== "application/vnd.google-apps.folder") return;
                var mm = String(c.name).match(/^\s*(\d+)\s*[-–—]\s*(.+)$/); // "N - Nome"
                if (mm) subs.push({ num: parseInt(mm[1], 10), name: mm[2].replace(/^\s+|\s+$/g, ""), id: c.id });
            });
            subs.sort(function (a, b) { return a.num - b.num; });
            if (!subs.length) { recLog("Drive: nenhuma subpasta no padrão 'N - Nome' encontrada.", "warn"); return; }
            recLog("Drive: " + subs.length + " produto(s): " + subs.map(function (s) { return s.num + " " + s.name; }).join(" | "));

            var i = 0;
            (function nextSub() {
                if (i >= subs.length) { recLog("✓ Drive: importação concluída — confira o png e clique em Criar em cada produto.", "ok"); return; }
                _driveImportOneProduct(apiKey, prjDir, subs[i++], renderCb, nextSub);
            })();
        });
    });
}

// Importa UMA subpasta: baixa imagens + .txt, monta o card via renderCb e segue (done()).
function _driveImportOneProduct(apiKey, prjDir, sub, renderCb, done) {
    var fs = tryNodeRequire('fs'), pmod = tryNodeRequire('path');
    var outDir = pmod.join(prjDir, "AutoEditor_Downloads", "PROD_" + sub.num);
    try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) {}
    recLog("Drive PROD_" + sub.num + " (" + sub.name + "): listando arquivos…");
    _driveList(apiKey, sub.id, function (err, files) {
        if (err) { recLog("✗ Drive PROD_" + sub.num + ": " + err.message, "err"); done(); return; }
        var imgs = [], txts = [];
        files.forEach(function (f) {
            if (/^image\//.test(f.mimeType || "")) imgs.push(f);
            else if ((f.mimeType === "text/plain") || /\.txt$/i.test(f.name || "")) txts.push(f);
        });
        var imgPaths = [], pngPath = null, links = [];

        function downloadAll(list, kind, after) {
            var k = 0;
            (function nx() {
                if (k >= list.length) { after(); return; }
                var f = list[k++];
                var dest = pmod.join(outDir, f.name);
                recLog("  baixando " + kind + ": " + f.name);
                _driveDownload(apiKey, f.id, dest, function (e2) {
                    if (e2) { recLog("  ✗ " + f.name + ": " + e2.message, "err"); }
                    else if (kind === "imagem") { imgPaths.push(dest); if (!pngPath && /\.png$/i.test(f.name)) pngPath = dest; }
                    else { try { links = links.concat(_extractLinksFromText(fs.readFileSync(dest, "utf8"))); } catch (e3) {} }
                    nx();
                });
            })();
        }

        downloadAll(imgs, "imagem", function () {
            downloadAll(txts, "txt", function () {
                if (!pngPath && imgPaths.length) pngPath = imgPaths[0]; // sem .png → 1ª imagem
                recLog("✓ Drive PROD_" + sub.num + ": " + imgPaths.length + " imagem(ns), " + links.length + " link(s) de vídeo.", "ok");
                try { renderCb(sub.num, { stagedFiles: imgPaths, refPath: pngPath, videoLinks: links }); } catch (eR) { recLog("✗ card PROD_" + sub.num + ": " + eR.message, "err"); }
                done();
            });
        });
    });
}

function startNewProductCard() {
    if (_pendingProductCard) {
        recLog("Finalize ou cancele o produto atual antes de adicionar outro.", "warn");
        return;
    }
    var addBtn = document.getElementById("btn-add-product");
    if (addBtn) addBtn.disabled = true;
    cs.evalScript("getNextProductNumber()", function (raw) {
        var n = 1;
        try { var r = JSON.parse(raw); if (r && r.next) n = r.next; } catch (e) {}
        renderProductCard(n);
    });
}

function renderProductCard(n, opts) {
    var container = document.getElementById("products-container");
    var card = document.createElement("div");
    card.style.cssText = "border:1px solid #444;border-radius:6px;padding:10px;margin-top:10px;background:#2a2a2a";

    var files = [];         // staged files (não-importados ainda) — pré OU adicionando mais
    var refPath = null;     // imagem marcada como referência (png), só pré-criação
    var _isCreated = !!(opts && opts.restored); // true se restaurado do localStorage
    var _isExpanded = true; // staging visível (drop/url/list/botões)
    var _busy = false;      // true enquanto analisa/baixa link → trava o "Criar/Adicionar"

    var header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:6px";
    var title = document.createElement("div");
    title.style.cssText = "font-weight:bold;flex:1";
    title.textContent = "PRODUTO " + n;
    header.appendChild(title);
    // Botão remover (só aparece em produto já criado) — limpa o estado preso e
    // apaga o bin PROD_N do projeto, pra poder recriar do zero.
    var delBtn = document.createElement("button");
    delBtn.textContent = "🗑";
    delBtn.title = "Remover PRODUTO " + n + " (apaga o bin PROD_" + n + " do projeto)";
    delBtn.style.cssText = "background:none;border:none;color:#c66;cursor:pointer;font-size:14px;display:none";
    header.appendChild(delBtn);
    card.appendChild(header);

    // === Staging (expanded) ===
    var expandedView = document.createElement("div");
    card.appendChild(expandedView);

    var drop = document.createElement("div");
    drop.style.cssText = "border:2px dashed #555;border-radius:6px;padding:14px;text-align:center;color:#999;cursor:pointer;margin-bottom:8px";
    drop.textContent = "Arraste vídeos, imagens ou um .txt com links aqui, ou clique para selecionar";
    expandedView.appendChild(drop);

    var ytWrap = document.createElement("div");
    ytWrap.style.cssText = "display:flex;gap:6px;margin-bottom:8px";
    var ytIn = document.createElement("input");
    ytIn.type = "text";
    ytIn.placeholder = "...ou cole URL (YouTube, Amazon, etc)";
    ytIn.style.cssText = "flex:1;padding:5px 8px;background:#1e1e1e;color:#ddd;border:1px solid #444;border-radius:4px";
    var ytBtn = document.createElement("button");
    ytBtn.textContent = "Baixar";
    ytBtn.style.cssText = "min-width:80px";
    ytWrap.appendChild(ytIn);
    ytWrap.appendChild(ytBtn);
    expandedView.appendChild(ytWrap);

    var listEl = document.createElement("div");
    listEl.style.cssText = "font-family:monospace;font-size:11px;margin-bottom:8px";
    expandedView.appendChild(listEl);

    var actions = document.createElement("div");
    actions.className = "row-space";
    var submitBtn = document.createElement("button");
    submitBtn.className = "btn-primary flex1";
    submitBtn.textContent = "Criar PRODUTO " + n;
    submitBtn.disabled = true;
    var cancelBtn = document.createElement("button");
    cancelBtn.className = "flex1";
    cancelBtn.textContent = "Cancelar";
    actions.appendChild(submitBtn);
    actions.appendChild(cancelBtn);
    expandedView.appendChild(actions);

    // === Collapsed (só pós-criação): botão "+ ARQUIVO" no final do card ===
    var collapsedAddBtn = document.createElement("button");
    collapsedAddBtn.textContent = "+ ARQUIVO";
    collapsedAddBtn.style.cssText = "display:none;width:100%;margin-top:2px";
    card.appendChild(collapsedAddBtn);

    container.appendChild(card);

    if (opts && opts.restored) {
        // Card restaurado: já está criado, colapsa imediatamente sem bloquear o botão.
        title.textContent = "✓ PRODUTO " + n;
        setCollapsed(true);
    } else if (opts && opts.driveStaged) {
        // Importação do Drive: staging pré-preenchido (imagens) + png pré-marcado.
        // Vários cards coexistem → NÃO trava o "+ Adicionar Produto". O usuário só
        // confere/ajusta o png e clica Criar; os vídeos do .txt baixam na fila.
        (opts.stagedFiles || []).forEach(function (p) {
            if (p && !files.some(function (f) { return f.path === p; })) {
                files.push({ path: p, name: recBaseName(p), isImage: recIsImage(p) });
            }
        });
        if (opts.refPath) refPath = opts.refPath;
        renderList();
        setCollapsed(false);
        if (opts.videoLinks && opts.videoLinks.length) downloadUrlQueue(opts.videoLinks);
    } else {
        _pendingProductCard = card;
    }

    function releaseAddBtn() {
        _pendingProductCard = null;
        var addBtn = document.getElementById("btn-add-product");
        if (addBtn) addBtn.disabled = false;
    }

    function setCollapsed(collapsed) {
        _isExpanded = !collapsed;
        expandedView.style.display = collapsed ? "none" : "";
        collapsedAddBtn.style.display = (collapsed && _isCreated) ? "" : "none";
        delBtn.style.display = _isCreated ? "" : "none"; // remover só faz sentido se criado
    }

    // Abre o staging pra adicionar mais arquivos a um PRODUTO já criado.
    function expandForAddMore() {
        files = [];
        refPath = null;
        submitBtn.textContent = "Adicionar Arquivos";
        submitBtn.disabled = true;
        cancelBtn.disabled = false;
        cancelBtn.style.display = "";
        submitBtn.style.display = "";
        renderList();
        setCollapsed(false);
    }

    collapsedAddBtn.addEventListener("click", expandForAddMore);

    delBtn.addEventListener("click", function () {
        if (!window.confirm("Remover PRODUTO " + n + "?\n\nApaga o bin PROD_" + n + " do projeto (se existir) e tira o produto do plugin. Os arquivos em disco NÃO são apagados.")) return;
        delBtn.disabled = true;
        cs.evalScript("deleteProductBin(" + JSON.stringify(n) + ")", function (raw) {
            var r = {}; try { r = JSON.parse(raw); } catch (e) {}
            if (r && r.ok) {
                recLog("✓ PRODUTO " + n + " removido" + (r.removed ? " (bin apagado)." : " (bin não existia)."), "ok");
            } else {
                recLog("⚠ Não apaguei o bin PROD_" + n + ": " + (r.error || raw) + " — removido só do plugin.", "warn");
            }
            // Esquece do estado/UI independentemente (o objetivo é destravar).
            var idx = _createdProducts.indexOf(n);
            if (idx >= 0) _createdProducts.splice(idx, 1);
            saveProjectData();
            try { container.removeChild(card); } catch (e) {}
            if (_pendingProductCard === card) releaseAddBtn();
            if (typeof updateMountButton === "function") updateMountButton();
        });
    });

    function renderList() {
        listEl.innerHTML = "";
        if (!files.length) {
            listEl.innerHTML = "<span style='color:#777'>nenhum arquivo adicionado</span>";
            submitBtn.disabled = true;
            return;
        }
        // Na criação INICIAL, auto-seleciona a 1ª imagem como referência.
        // Em add-more (produto já criado) NÃO auto-seleciona: a ref só muda se o
        // usuário escolher explicitamente (senão o host mantém a atual).
        if (!_isCreated && (!refPath || !files.some(function (f) { return f.path === refPath; }))) {
            var firstImg = files.filter(function (f) { return f.isImage; })[0];
            refPath = firstImg ? firstImg.path : null;
        }
        // Dica em add-more, quando há imagem: dá pra (re)definir a referência.
        if (_isCreated && files.some(function (f) { return f.isImage; })) {
            var note = document.createElement("div");
            note.style.cssText = "font-size:10px;color:#8c9;margin-bottom:4px";
            note.textContent = "Clique numa imagem (ou marque \"ref (png)\") pra defini-la como referência. Sem escolher, a atual é mantida.";
            listEl.appendChild(note);
        }
        files.forEach(function (f) {
            var row = document.createElement("div");
            row.style.cssText = "display:flex;align-items:center;gap:6px;padding:2px 0";

            if (f.isImage) {
                var thumb = document.createElement("img");
                thumb.src = "file:///" + f.path.replace(/\\/g, "/");
                var isRef = (f.path === refPath);
                thumb.style.cssText = "width:36px;height:36px;object-fit:cover;border-radius:4px;flex-shrink:0;border:2px solid " + (isRef ? "#9cf" : "#444") + ";cursor:pointer";
                thumb.addEventListener("click", function () {
                    refPath = f.path;
                    renderList();
                });
                row.appendChild(thumb);
            } else {
                var tag = document.createElement("span");
                tag.textContent = "🎬";
                row.appendChild(tag);
            }

            var nameSpan = document.createElement("span");
            nameSpan.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
            nameSpan.textContent = f.name;
            row.appendChild(nameSpan);

            // Radio ref (png): na criação inicial OU pra trocar a referência depois.
            if (f.isImage) {
                var lbl = document.createElement("label");
                lbl.style.cssText = "font-size:10px;color:#9cf;cursor:pointer;white-space:nowrap";
                var radio = document.createElement("input");
                radio.type = "radio";
                radio.name = "ref_prod_" + n;
                radio.checked = (f.path === refPath);
                radio.addEventListener("change", function () { refPath = f.path; renderList(); });
                lbl.appendChild(radio);
                lbl.appendChild(document.createTextNode(" ref (png)"));
                row.appendChild(lbl);
            }
            // Botão remover staged (pré-import).
            var rm = document.createElement("button");
            rm.textContent = "✕";
            rm.style.cssText = "background:none;border:none;color:#c66;cursor:pointer";
            rm.addEventListener("click", function () {
                files = files.filter(function (x) { return x.path !== f.path; });
                renderList();
            });
            row.appendChild(rm);

            listEl.appendChild(row);
        });
        submitBtn.disabled = _busy; // durante análise/download fica travado
    }

    // Trava/destrava os controles do card enquanto analisa link ou baixa, pra não
    // criar/adicionar o produto com arquivos ainda incompletos.
    function setBusy(busy) {
        _busy = busy;
        cancelBtn.disabled = busy;
        if (collapsedAddBtn) collapsedAddBtn.disabled = busy;
        if (delBtn) delBtn.disabled = busy;
        drop.style.pointerEvents = busy ? "none" : "";
        drop.style.opacity = busy ? "0.5" : "";
        if (busy) submitBtn.disabled = true;
        else renderList(); // re-define o submit conforme há (ou não) arquivos
    }

    function addPaths(paths) {
        var txts = [];
        (paths || []).forEach(function (p) {
            if (!p) return;
            // Arquivo .txt = LISTA DE LINKS → baixa em fila (não entra como mídia).
            if (/\.txt$/i.test(p)) { txts.push(p); return; }
            if (files.some(function (f) { return f.path === p; })) return;
            files.push({ path: p, name: recBaseName(p), isImage: recIsImage(p) });
        });
        renderList();
        if (txts.length) {
            var urls = [];
            txts.forEach(function (tp) { urls = urls.concat(readLinksFromTxt(tp)); });
            if (urls.length) downloadUrlQueue(urls);
            else recLog("Nenhum link http(s) encontrado no(s) .txt.", "warn");
        }
    }

    // Lê um .txt e extrai 1 link http(s) por linha (ignora texto/linhas em branco).
    function readLinksFromTxt(txtPath) {
        var out = [];
        try {
            var fs = tryNodeRequire("fs");
            var content = fs.readFileSync(txtPath, "utf8");
            content.split(/\r?\n/).forEach(function (line) {
                var m = String(line).match(/https?:\/\/\S+/);
                if (m) out.push(m[0]);
            });
        } catch (e) { recLog("Erro lendo " + recBaseName(txtPath) + ": " + e.message, "err"); }
        return out;
    }

    // Baixa uma lista de URLs EM FILA (uma de cada vez) na pasta do produto.
    // Cada vídeo baixado entra no staging automaticamente.
    function downloadUrlQueue(urls) {
        ytBtn.disabled = true; ytIn.disabled = true;
        setBusy(true);
        var origLabel = ytBtn.textContent;
        var i = 0, ok = 0, failed = 0;
        recLog("Fila de download: " + urls.length + " link(s)…");
        function next() {
            if (i >= urls.length) {
                ytBtn.disabled = false; ytIn.disabled = false; ytBtn.textContent = origLabel;
                setBusy(false);
                recLog("✓ Fila concluída: " + ok + " baixado(s)" + (failed ? ", " + failed + " falhou" : "") + ".",
                       failed ? "warn" : "ok");
                return;
            }
            var url = urls[i];
            ytBtn.textContent = "Fila " + (i + 1) + "/" + urls.length + "…";
            recLog("Fila " + (i + 1) + "/" + urls.length + ": " + url.substring(0, 70) + (url.length > 70 ? "…" : ""));
            downloadYTToFolder(n, url,
                function onProgress(label) { ytBtn.textContent = (i + 1) + "/" + urls.length + " " + label; },
                function onDone(err, filePath) {
                    if (err) { failed++; recLog("✗ link " + (i + 1) + ": " + err.message, "err"); }
                    else { var ps = [].concat(filePath); ok += ps.length; addPaths(ps); }
                    i++; next();
                },
                chooseVideosModal
            );
        }
        next();
    }

    drop.addEventListener("click", function () {
        cs.evalScript("selectMediaFiles()", function (raw) {
            try {
                var r = JSON.parse(raw);
                if (r && r.paths) addPaths(r.paths);
                else if (r && r.error) recLog("Erro ao selecionar: " + r.error, "err");
            } catch (e) { recLog("Resposta inválida ao selecionar arquivos.", "err"); }
        });
    });
    drop.addEventListener("dragover", function (e) {
        e.preventDefault(); e.stopPropagation(); drop.style.borderColor = "#9cf";
    });
    drop.addEventListener("dragleave", function (e) {
        e.preventDefault(); e.stopPropagation(); drop.style.borderColor = "#555";
    });
    drop.addEventListener("drop", function (e) {
        e.preventDefault(); e.stopPropagation(); drop.style.borderColor = "#555";
        var dropped = [];
        var fl = e.dataTransfer && e.dataTransfer.files;
        if (fl) for (var i = 0; i < fl.length; i++) { if (fl[i].path) dropped.push(fl[i].path); }
        if (dropped.length) addPaths(dropped);
        else recLog("Arrastar não retornou o caminho nesta versão — use o clique para selecionar.", "warn");
    });

    ytBtn.addEventListener("click", function () {
        var raw = (ytIn.value || "").trim();
        if (!raw) { recLog("Cole uma URL primeiro.", "warn"); return; }
        // Aceita VÁRIOS links colados (1 por linha ou separados por espaço) → fila.
        var multi = (raw.match(/https?:\/\/\S+/g) || []);
        if (multi.length > 1) { ytIn.value = ""; downloadUrlQueue(multi); return; }
        var url = multi.length ? multi[0] : raw;
        ytBtn.disabled = true; ytIn.disabled = true;
        setBusy(true);
        var originalLabel = ytBtn.textContent;
        ytBtn.textContent = "Baixando…";
        downloadYTToFolder(n, url,
            function onProgress(label) { ytBtn.textContent = label; },
            function onDone(err, filePath) {
                ytBtn.disabled = false; ytIn.disabled = false;
                ytBtn.textContent = originalLabel;
                setBusy(false);
                if (err) { recLog("✗ " + err.message, "err"); return; }
                ytIn.value = "";
                addPaths([].concat(filePath)); // string OU array (multi-vídeo) → staging
            },
            chooseVideosModal
        );
    });
    ytIn.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); ytBtn.click(); }
    });

    cancelBtn.addEventListener("click", function () {
        if (_isCreated) {
            // Add-more: descarta staging e fecha. PRODUTO segue existindo.
            files = []; refPath = null;
            setCollapsed(true);
        } else {
            // Criação inicial: descarta o card todo.
            try { container.removeChild(card); } catch (e) {}
            releaseAddBtn();
        }
    });

    submitBtn.addEventListener("click", function () {
        if (!files.length) return;
        submitBtn.disabled = true; cancelBtn.disabled = true;
        var paths = files.map(function (f) { return f.path; });
        // refPath só é setado se o usuário escolher uma imagem como referência.
        // Em add-more, se ele NÃO escolher, refArg = "" → o host mantém a ref atual.
        // Se escolher (ex: re-setar o png após apagar), o host renomeia pra "png".
        var refArg = refPath || "";
        var arg = JSON.stringify(n) + "," +
                  JSON.stringify(JSON.stringify(paths)) + "," +
                  JSON.stringify(refArg);
        if (_isCreated) recLog("Adicionando " + paths.length + " arquivo(s) ao PRODUTO " + n + "…");
        else            recLog("Criando PRODUTO " + n + " com " + paths.length + " arquivo(s)…");
        cs.evalScript("addProductMedia(" + arg + ")", function (raw) {
            var r = {};
            try { r = JSON.parse(raw); } catch (e) {}
            if (r && r.ok) {
                if (!_isCreated) {
                    var msg = "✓ PRODUTO " + n + " criado — " + r.imported + " importado(s)";
                    if (r.failed && r.failed.length) msg += ", " + r.failed.length + " falhou";
                    msg += " | referência: " + r.ref;
                    recLog(msg, "ok");
                    _isCreated = true;
                    title.textContent = "✓ PRODUTO " + n;
                    // Persiste o produto no localStorage para restaurar ao reabrir
                    if (_createdProducts.indexOf(n) < 0) _createdProducts.push(n);
                    saveProjectData();
                    releaseAddBtn(); // libera o "+ Adicionar Produto"
                } else {
                    recLog("✓ +" + r.imported + " arquivo(s) em PRODUTO " + n, "ok");
                }
                // Colapsa o card: só título + "+ ARQUIVO" no final.
                files = []; refPath = null;
                setCollapsed(true);
            } else {
                recLog("✗ Erro: " + (r.error || raw), "err");
                submitBtn.disabled = false; cancelBtn.disabled = false;
            }
        });
    });

    renderList();
}

function createTemplateSequencesAction() {
    var btn = document.getElementById("btn-create-templates");
    if (btn) btn.disabled = true;
    recLog("Criando sequências de template…");
    var arg = JSON.stringify(JSON.stringify(TEMPLATE_SEQ_NAMES));
    cs.evalScript("createTemplateSequences(" + arg + ")", function (raw) {
        var r = {};
        try { r = JSON.parse(raw); } catch (e) {}
        if (r && r.ok) {
            if (r.created && r.created.length) recLog("✓ Criadas: " + r.created.join(", "), "ok");
            if (r.skipped && r.skipped.length) recLog("• Já existiam (puladas): " + r.skipped.join(", "));
            if (r.failed && r.failed.length) {
                r.failed.forEach(function (f) {
                    recLog("✗ Falhou: " + f.name + " — " + (f.attempts ? f.attempts.join(" | ") : ""), "err");
                });
            }
            if ((!r.created || !r.created.length) && (!r.failed || !r.failed.length)) {
                recLog("Tudo certo — todas as sequências já existiam.", "ok");
            }
        } else {
            recLog("✗ Erro: " + (r.error || raw), "err");
        }
        if (btn) btn.disabled = false;
        // Re-checa as faltantes — se acabaram, a seção some sozinha.
        refreshTemplateSeqSection();
    });
}

// ─── IA (Gemini image generation) ─────────────────────────────────────────────

var GEMINI_KEY_STORAGE   = "autoeditor_gemini_key";
var GEMINI_MODEL_STORAGE = "autoeditor_gemini_model";
var IA_SLOT_DUR_STORAGE  = "autoeditor_ia_slot_duration";
var IA_NUM_IMAGES_STORAGE = "autoeditor_ia_num_images";

// Máximo de imagens por produto (default 7). Cap pra geração.
function getNumImages() {
    var el = document.getElementById("ia-num-images");
    var n = parseInt((el && el.value) || "7", 10);
    if (!(n > 0)) n = 7;
    return n;
}

// Conta quantas imagens gen_N existem de fato pra um produto (sequencial, até o teto).
// Usado no auto-fill/recap pra não referenciar gen_N que não foram gerados.
function countGenImages(prod) {
    var max = getNumImages();
    var folder = (prod.folder || "").replace(/\//g, "\\");
    var n = 0;
    for (var i = 1; i <= max; i++) {
        var p = resolvePath(folder + "\\gen_" + i + ".png");
        if (getImageDimensions(p)) n++; else break; // para no 1º buraco (são sequenciais)
    }
    return n;
}

// Atualiza o texto "≈ Xs por ciclo" baseado em nº de imagens × duração por imagem.
function updateCycleHint() {
    var hint = document.getElementById("ia-cycle-hint");
    if (!hint) return;
    var slotEl = document.getElementById("ia-slot-duration");
    var dur = parseFloat((slotEl && slotEl.value) || "5") || 5;
    var n = getNumImages();
    var total = n * dur;
    hint.textContent = "≈ " + (total % 1 === 0 ? total : total.toFixed(1)) + "s por ciclo de imagens (" + n + " × " + dur + "s)";
}

// Estado de geração — usado pelos botões Cancelar / Pular
var _iaCancelled       = false;
var _iaSkipCurrent     = false;
var _iaCurrentRequest  = null; // referência à request HTTPS em andamento (pra destruir)
var _iaInProgress      = false;
var _genBinMedia       = null; // cache de getProductBinMedia durante uma geração
var _genProjDir        = null; // cache do diretório do projeto durante uma geração

// Estima a duração do segmento de imagens de um produto (PRODUTO→PRECO menos o
// card) via transcript. Retorna segundos ou null se não der pra resolver.
function productImageRegionDuration(prod, cursorRef) {
    var produtoT = null, precoT = null;
    (prod.timeline || []).forEach(function (it) {
        if (it.type !== "template_insert" || !it.after_phrase) return;
        var tn = (it.template || "").toUpperCase();
        var isProd = tn.indexOf("PRODUTO") >= 0, isPreco = tn.indexOf("PRECO") >= 0;
        if (!isProd && !isPreco) return;
        var t = findPhraseTime(it.after_phrase, cursorRef.v);
        if (t === null) return;
        cursorRef.v = t;
        if (isProd && produtoT === null) produtoT = t;
        if (isPreco) precoT = t;
    });
    if (produtoT !== null && precoT !== null && precoT > produtoT) {
        return (precoT - produtoT) - 5; // ~5s do card PRODUTO antes das imagens
    }
    return null;
}

function initIA() {
    var keyInput   = document.getElementById("gemini-api-key");
    var modelInput = document.getElementById("gemini-model");
    var slotInput  = document.getElementById("ia-slot-duration");
    var keyStatus  = document.getElementById("gemini-key-status");
    var btnTest    = document.getElementById("btn-ia-test");
    var btnGen     = document.getElementById("btn-ia-generate");
    var btnGenM    = document.getElementById("btn-ia-generate-missing");

    // Carrega valores persistidos
    try {
        var savedKey   = localStorage.getItem(GEMINI_KEY_STORAGE);
        var savedModel = localStorage.getItem(GEMINI_MODEL_STORAGE);
        var savedSlot  = localStorage.getItem(IA_SLOT_DUR_STORAGE);
        var savedNum   = localStorage.getItem(IA_NUM_IMAGES_STORAGE);
        if (savedKey)   keyInput.value = savedKey;
        if (savedModel) modelInput.value = savedModel;
        if (savedSlot)  slotInput.value = savedSlot;
        var numEl = document.getElementById("ia-num-images");
        if (savedNum && numEl) numEl.value = savedNum;
    } catch(e) {}

    updateIAStatus();
    updateIAButtonsEnabled();

    keyInput.addEventListener("change", function() {
        try { localStorage.setItem(GEMINI_KEY_STORAGE, keyInput.value.trim()); } catch(e) {}
        updateIAStatus();
        updateIAButtonsEnabled();
    });
    keyInput.addEventListener("input", updateIAButtonsEnabled);

    modelInput.addEventListener("change", function() {
        try { localStorage.setItem(GEMINI_MODEL_STORAGE, modelInput.value.trim()); } catch(e) {}
    });

    slotInput.addEventListener("change", function() {
        try { localStorage.setItem(IA_SLOT_DUR_STORAGE, slotInput.value.trim()); } catch(e) {}
        updateCycleHint();
    });
    slotInput.addEventListener("input", updateCycleHint);

    var numInput = document.getElementById("ia-num-images");
    if (numInput) {
        numInput.addEventListener("change", function() {
            try { localStorage.setItem(IA_NUM_IMAGES_STORAGE, numInput.value.trim()); } catch(e) {}
            updateCycleHint();
        });
        numInput.addEventListener("input", updateCycleHint);
    }
    updateCycleHint();

    // Cleanup: garante que flag MOGRT zoom obsoleta não fica ativa de sessões antigas
    try { localStorage.removeItem("autoeditor.useMOGRTZoom"); } catch(e) {}

    // Checkbox "Aplicar preset de zoom após mount"
    var zoomChk = document.getElementById("ia-apply-zoom-preset");
    if (zoomChk) {
        try {
            zoomChk.checked = localStorage.getItem("autoeditor.applyZoomPreset") === "true";
        } catch(e) {}
        zoomChk.addEventListener("change", function() {
            try { localStorage.setItem("autoeditor.applyZoomPreset", zoomChk.checked ? "true" : "false"); } catch(e) {}
            log("Preset de zoom: " + (zoomChk.checked ? "ON (alterna ZOOMIN/ZOOMOUT após mount)" : "OFF"), "info");
        });
    }

    btnTest.addEventListener("click", testGeminiConnection);
    btnGen.addEventListener("click", function() { generateAllImages(false); });
    btnGenM.addEventListener("click", function() { generateAllImages(true); });

    var btnCancel = document.getElementById("btn-ia-cancel");
    if (btnCancel) btnCancel.addEventListener("click", cancelIAGeneration);

    var btnSkip = document.getElementById("btn-ia-skip");
    if (btnSkip) btnSkip.addEventListener("click", skipCurrentIA);

}

// Chama o teste de aplicação de preset no ExtendScript e mostra resultado
// (removidas funções testApplyPreset e debugReadMOGRT — features descartadas)

// Marca cancelamento de TUDO e tenta abortar a request HTTP em andamento
function cancelIAGeneration() {
    if (!_iaInProgress) return;
    _iaCancelled = true;
    iaLog("Cancelamento TOTAL solicitado — aguardando request atual encerrar...", "warn");
    if (_iaCurrentRequest) {
        try { _iaCurrentRequest.destroy(); } catch(e) {}
        _iaCurrentRequest = null;
    }
}

// Pula só a IMAGEM ATUAL (aborta a request em andamento mas mantém a fila)
function skipCurrentIA() {
    if (!_iaInProgress) return;
    _iaSkipCurrent = true;
    iaLog("Pular solicitado — abortando request atual, próxima imagem em seguida...", "warn");
    if (_iaCurrentRequest) {
        try { _iaCurrentRequest.destroy(); } catch(e) {}
        _iaCurrentRequest = null;
    }
}

function updateIAStatus() {
    var keyStatus = document.getElementById("gemini-key-status");
    var key = (document.getElementById("gemini-api-key").value || "").trim();
    if (!key) {
        keyStatus.textContent = "nenhuma chave configurada";
        keyStatus.className   = "root-folder-hint";
    } else {
        var masked = key.substring(0, 6) + "..." + key.substring(key.length - 4);
        keyStatus.textContent = "chave: " + masked;
        keyStatus.className   = "root-folder-hint ok";
    }
}

function updateIAButtonsEnabled() {
    var keyOk  = !!(document.getElementById("gemini-api-key").value || "").trim();
    var jsonOk = !!loadedJSON;
    var canGen = keyOk && jsonOk && !_iaInProgress;

    var btnG  = document.getElementById("btn-ia-generate");
    var btnGm = document.getElementById("btn-ia-generate-missing");
    var btnC  = document.getElementById("btn-ia-cancel");
    var btnS  = document.getElementById("btn-ia-skip");
    if (btnG)  btnG.disabled  = !canGen;
    if (btnGm) btnGm.disabled = !canGen;
    if (btnC)  btnC.disabled  = !_iaInProgress;
    if (btnS)  btnS.disabled  = !_iaInProgress;
}

function iaLog(msg, tipo) {
    var box = document.getElementById("ia-progress");
    if (!box) return;
    var t = new Date();
    var ts = ("0" + t.getHours()).slice(-2) + ":" +
             ("0" + t.getMinutes()).slice(-2) + ":" +
             ("0" + t.getSeconds()).slice(-2) + "." +
             ("00" + t.getMilliseconds()).slice(-3);
    var div = document.createElement("div");
    div.className = "log-entry " + (tipo || "info");
    div.textContent = "[" + ts + "] " + msg;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
    // Espelha no log principal também
    if (typeof log === "function") log("[IA] " + msg, tipo);
}

function copyIALog() {
    var box = document.getElementById("ia-progress");
    if (!box) return;
    var text = "";
    var entries = box.querySelectorAll(".log-entry");
    for (var i = 0; i < entries.length; i++) text += entries[i].textContent + "\n";
    try {
        var ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        iaLog("Log copiado pra área de transferência.", "ok");
    } catch(e) { iaLog("Falha ao copiar: " + e.message, "error"); }
}

function clearIALog() {
    var box = document.getElementById("ia-progress");
    if (box) box.innerHTML = "";
}

// Detecta o formato REAL de uma imagem pelos magic bytes (não confia em MIME/extensão).
// Retorna { ext, mime } ou null se desconhecido.
function detectImageFormat(buf) {
    if (!buf || buf.length < 12) return null;
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
        return { ext: "png", mime: "image/png" };
    }
    // JPEG: FF D8 FF
    if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) {
        return { ext: "jpg", mime: "image/jpeg" };
    }
    // WebP: "RIFF" .... "WEBP"
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
        return { ext: "webp", mime: "image/webp" };
    }
    // GIF: GIF87a or GIF89a
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
        return { ext: "gif", mime: "image/gif" };
    }
    // BMP: BM
    if (buf[0] === 0x42 && buf[1] === 0x4D) {
        return { ext: "bmp", mime: "image/bmp" };
    }
    // TIFF: II 2A 00 (LE) ou MM 00 2A (BE)
    if ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2A && buf[3] === 0x00) ||
        (buf[0] === 0x4D && buf[1] === 0x4D && buf[2] === 0x00 && buf[3] === 0x2A)) {
        return { ext: "tif", mime: "image/tiff" };
    }
    return null;
}

// Testa a chave + lista modelos relacionados a imagem disponíveis pra sua conta.
function testGeminiConnection() {
    var key = (document.getElementById("gemini-api-key").value || "").trim();
    if (!key) { iaLog("Sem chave configurada.", "error"); return; }
    iaLog("Testando conexão e listando modelos...", "info");

    var https = tryNodeRequire("https");
    if (!https) { iaLog("Node https indisponível neste contexto CEP.", "error"); return; }

    var req = https.request({
        hostname: "generativelanguage.googleapis.com",
        path: "/v1beta/models?key=" + encodeURIComponent(key) + "&pageSize=500",
        method: "GET",
        headers: { "Content-Type": "application/json" }
    }, function(res) {
        var chunks = [];
        res.on("data", function(c) { chunks.push(c); });
        res.on("end", function() {
            var body = Buffer.concat(chunks).toString("utf8");
            if (res.statusCode !== 200) {
                iaLog("Falha HTTP " + res.statusCode + ": " + body.substring(0, 200), "error");
                return;
            }
            try {
                var data = JSON.parse(body);
                var models = data.models || [];
                iaLog("Conexão OK — " + models.length + " modelo(s) total.", "ok");

                // Filtra modelos de imagem (nome contém "image" ou "imagen")
                var imgModels = [];
                models.forEach(function(m) {
                    var name = (m.name || "").replace(/^models\//, "");
                    var lower = name.toLowerCase();
                    var isImage = lower.indexOf("image") >= 0 || lower.indexOf("imagen") >= 0;
                    var supportsGen = (m.supportedGenerationMethods || []).indexOf("generateContent") >= 0 ||
                                      (m.supportedGenerationMethods || []).indexOf("predict") >= 0;
                    if (isImage && supportsGen) {
                        imgModels.push({
                            name: name,
                            methods: m.supportedGenerationMethods || []
                        });
                    }
                });

                if (imgModels.length === 0) {
                    iaLog("Nenhum modelo de imagem disponível pra esta chave.", "warn");
                    iaLog("Pode ser que precise habilitar billing em https://aistudio.google.com/app/billing", "warn");
                } else {
                    iaLog("Modelos de IMAGEM disponíveis (" + imgModels.length + "):", "ok");
                    imgModels.forEach(function(m) {
                        iaLog("  • " + m.name + "  [" + m.methods.join(", ") + "]", "info");
                    });
                    iaLog("Copie um dos nomes acima pro campo 'Modelo' se o atual não funcionar.", "info");
                }
            } catch(eP) {
                iaLog("Resposta 200 mas JSON inválido: " + body.substring(0, 100), "warn");
            }
        });
    });
    req.on("error", function(e) { iaLog("Erro: " + e.message, "error"); });
    req.end();
}

// Chama Gemini Image Generation com referência + prompt.
// Retorna Promise-like via callback: cb(err, base64Png).
// logFn opcional — se passado, recebe mensagens detalhadas das fases HTTP.
function generateImageWithGemini(apiKey, model, prompt, refPngBase64, cb, logFn) {
    var https = tryNodeRequire("https");
    if (!https) { cb(new Error("Node https indisponível")); return; }

    var phase = function(msg) { if (logFn) logFn(msg); };

    var parts = [];
    if (refPngBase64) {
        parts.push({
            inline_data: {
                mime_type: "image/png",
                data:      refPngBase64
            }
        });
    }
    parts.push({ text: prompt });

    // responseModalities ["TEXT", "IMAGE"] funciona em ambos:
    // - gemini-2.0-flash-exp-image-generation (REQUER esta config)
    // - gemini-2.5-flash-image / Nano Banana (também aceita; pode retornar só image)
    // O parser abaixo procura a primeira parte com inline_data e ignora text.
    var payload = JSON.stringify({
        contents: [{ parts: parts }],
        generationConfig: {
            responseModalities: ["TEXT", "IMAGE"]
        }
    });

    phase("HTTP: payload " + Buffer.byteLength(payload) + " bytes (ref " +
          (refPngBase64 ? Math.round(refPngBase64.length * 0.75 / 1024) + " KB" : "nenhuma") + ")");

    var responded = false;
    var safeCb = function(err, b64, mime) {
        if (responded) return;
        responded = true;
        cb(err, b64, mime);
    };

    var t0 = Date.now();
    var elapsed = function() { return ((Date.now() - t0) / 1000).toFixed(2) + "s"; };

    var req = https.request({
        hostname: "generativelanguage.googleapis.com",
        path: "/v1beta/models/" + encodeURIComponent(model) + ":generateContent?key=" + encodeURIComponent(apiKey),
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload)
        },
        timeout: 120000  // 2 minutos no socket
    }, function(res) {
        phase("HTTP: " + elapsed() + " response HEAD status=" + res.statusCode);
        var chunks    = [];
        var totalSize = 0;
        var firstByte = null;
        res.on("data", function(c) {
            if (firstByte === null) { firstByte = Date.now(); phase("HTTP: " + elapsed() + " primeiros bytes recebidos"); }
            chunks.push(c);
            totalSize += c.length;
        });
        res.on("end", function() {
            phase("HTTP: " + elapsed() + " body completo (" + (totalSize / 1024).toFixed(1) + " KB)");
            var body = Buffer.concat(chunks).toString("utf8");
            if (res.statusCode !== 200) {
                safeCb(new Error("HTTP " + res.statusCode + ": " + body.substring(0, 300)));
                return;
            }
            try {
                var data = JSON.parse(body);
                // Procura a primeira parte com inline_data (imagem)
                var cands = data.candidates || [];
                for (var c = 0; c < cands.length; c++) {
                    var cParts = (cands[c].content && cands[c].content.parts) || [];
                    for (var p = 0; p < cParts.length; p++) {
                        var part = cParts[p];
                        if (part.inline_data && part.inline_data.data) {
                            phase("HTTP: " + elapsed() + " imagem decodificada");
                            safeCb(null, part.inline_data.data, part.inline_data.mime_type || "image/png");
                            return;
                        }
                        if (part.inlineData && part.inlineData.data) {
                            phase("HTTP: " + elapsed() + " imagem decodificada");
                            safeCb(null, part.inlineData.data, part.inlineData.mimeType || "image/png");
                            return;
                        }
                    }
                }
                // Log o que veio se não achou imagem
                phase("HTTP: resposta SEM imagem. JSON: " + body.substring(0, 400));
                safeCb(new Error("Resposta sem imagem"));
            } catch(eParse) {
                safeCb(new Error("JSON inválido: " + eParse.message));
            }
        });
        res.on("error", function(eRes) {
            phase("HTTP: " + elapsed() + " ERRO no response stream: " + eRes.message);
            safeCb(new Error("response err: " + eRes.message));
        });
    });

    req.on("socket", function(sock) {
        phase("HTTP: " + elapsed() + " socket obtido");
        sock.on("connect", function() { phase("HTTP: " + elapsed() + " socket TCP conectado"); });
        sock.on("secureConnect", function() { phase("HTTP: " + elapsed() + " TLS handshake completo"); });
    });
    req.on("error",   function(e) {
        phase("HTTP: " + elapsed() + " request ERR: " + e.message);
        safeCb(e);
    });
    req.on("timeout", function() {
        phase("HTTP: " + elapsed() + " SOCKET TIMEOUT — destruindo request");
        try { req.destroy(); } catch(e) {}
        safeCb(new Error("Timeout: sem resposta da API em 120s"));
    });

    // Watchdog adicional acima do socket: aborta após 130s mesmo se o socket não disparar timeout
    var watchdog = setTimeout(function() {
        if (responded) return;
        phase("HTTP: " + elapsed() + " WATCHDOG — abortando request");
        try { req.destroy(); } catch(e) {}
        safeCb(new Error("Watchdog: request abortada após 130s"));
    }, 130000);

    // Substitui safeCb pra limpar watchdog também
    var origSafeCb = safeCb;
    safeCb = function(err, b64, mime) {
        clearTimeout(watchdog);
        origSafeCb(err, b64, mime);
    };

    phase("HTTP: enviando payload...");
    req.write(payload);
    req.end();
    phase("HTTP: " + elapsed() + " request enviada, aguardando resposta...");
    return req; // permite ao chamador destruir a request (ex: cancelamento)
}

// Constrói o prompt completo aplicando o template de reforço de referência
function buildReinforcedPrompt(userPrompt) {
    return "Show the EXACT product from the reference image (preserve all colors, " +
           "branding, shape and proportions unchanged — do not invent details not " +
           "visible in the reference). " + userPrompt + " " +
           "Photo-realistic, professional product photography, 16:9 cinematic composition.";
}

// Orquestrador principal — itera produtos e gera imagens.
// onlyMissing = true → pula imagens já existentes em disco.
function generateAllImages(onlyMissing) {
    if (!loadedJSON) { iaLog("Carregue um JSON primeiro.", "error"); return; }

    var apiKey = (document.getElementById("gemini-api-key").value || "").trim();
    var model  = (document.getElementById("gemini-model").value || "gemini-2.5-flash-image").trim();
    if (!apiKey) { iaLog("Configure a chave da API.", "error"); return; }

    var fs = tryNodeRequire("fs");
    if (!fs) { iaLog("Node fs indisponível.", "error"); return; }

    var products = loadedJSON.products || [loadedJSON.product || {}];
    var maxImages = getNumImages(); // teto de imagens por produto (default 7)

    // ── 1ª chamada: lê os bins PROD_N (referência + vídeos) e o diretório do
    // projeto (async), guarda em cache e re-chama.
    if (_genBinMedia === null) {
        var __vf = products.map(function (p) { return String(p.folder || ""); });
        iaLog("Lendo bins PROD_N e diretório do projeto...", "info");
        cs.evalScript("getProductBinMedia(" + JSON.stringify(JSON.stringify(__vf)) + ")", function (rawV) {
            try { _genBinMedia = JSON.parse(rawV) || {}; } catch (e) { _genBinMedia = {}; }
            cs.evalScript("getProjectDir()", function (rawD) {
                try { _genProjDir = (JSON.parse(rawD).dir) || ""; } catch (e2) { _genProjDir = ""; }
                generateAllImages(onlyMissing); // re-chama com os caches preenchidos
            });
        });
        return;
    }
    var binMedia = _genBinMedia; var projDir = _genProjDir;
    _genBinMedia = null; _genProjDir = null; // consome (próxima geração re-busca)

    if (!projDir) {
        iaLog("Salve o projeto (.prproj) primeiro — preciso do diretório pra salvar as imagens.", "error");
        return;
    }
    var baseDir = projDir + "\\AutoEditor_IA";

    var slotDurGen = parseFloat((document.getElementById("ia-slot-duration") || {}).value || "5") || 5;
    var genCursor = { v: 0 }; // cursor compartilhado pra resolver segmentos em ordem

    var queue = []; // [{ pIdx, promptIdx, prompt, refPath, outPath, folder, label }]

    products.forEach(function(prod, pIdx) {
        var prompts = prod.image_prompts || [];
        if (prompts.length === 0) {
            iaLog("Produto " + (pIdx+1) + " (" + (prod.name || "?") + "): sem image_prompts — pulando.", "warn");
            return;
        }
        var bm = binMedia[String(prod.folder)];
        var refPath = bm ? bm.ref : null;
        if (!refPath) {
            iaLog("Produto " + (pIdx+1) + ": sem imagem de referência 'png' no bin PROD_" + prod.folder + " — pulando.", "error");
            return;
        }

        // Pasta de saída ao lado do projeto: <projDir>/AutoEditor_IA/PROD_N/
        var outDir = baseDir + "\\PROD_" + prod.folder;
        try { fs.mkdirSync(outDir, { recursive: true }); } catch (eMk) {
            try { fs.mkdirSync(baseDir); } catch (e1) {}
            try { fs.mkdirSync(outDir); } catch (e2) {}
        }

        // ── Quantas imagens gerar (teto = maxImages). Se há vídeo no bin, gera só
        // o necessário pra preencher DEPOIS do vídeo (usa o transcript pra estimar).
        var imagesNeeded = maxImages;
        var vTotal = (bm && bm.videoTotal) || 0;
        if (vTotal > 0) {
            var region = productImageRegionDuration(prod, genCursor);
            if (region !== null) {
                var remaining = region - vTotal;
                imagesNeeded = (remaining <= 0.2) ? 0 : Math.min(maxImages, Math.ceil(remaining / slotDurGen));
                iaLog("Produto " + (pIdx+1) + ": vídeo " + vTotal.toFixed(1) + "s, segmento ~" + region.toFixed(1) +
                      "s → gerar " + imagesNeeded + " imagem(ns) pra completar.", "info");
            } else {
                iaLog("Produto " + (pIdx+1) + ": vídeo detectado mas sem transcript pra estimar — gerando o máximo (" + maxImages + ").", "warn");
            }
        }
        if (imagesNeeded <= 0) {
            iaLog("Produto " + (pIdx+1) + ": vídeo cobre o segmento — nenhuma imagem necessária.", "ok");
            return;
        }

        prompts.forEach(function(prompt, idx) {
            if (idx >= imagesNeeded) return; // respeita o necessário/teto
            var outPathPng = outDir + "\\gen_" + (idx+1) + ".png";

            if (onlyMissing) {
                var foundValid = false;
                var imgExts = ["png", "jpg", "jpeg", "webp"];
                for (var e = 0; e < imgExts.length; e++) {
                    var candidate = outDir + "\\gen_" + (idx+1) + "." + imgExts[e];
                    if (!fs.existsSync(candidate)) continue;
                    try {
                        var fd = fs.openSync(candidate, "r");
                        var headBuf = Buffer.alloc(16);
                        fs.readSync(fd, headBuf, 0, 16, 0);
                        fs.closeSync(fd);
                        var fmt = detectImageFormat(headBuf);
                        if (fmt) { foundValid = true; iaLog("Skipping p" + (pIdx+1) + " img " + (idx+1) + " — já existe (" + fmt.mime + ")", "info"); break; }
                        else iaLog("p" + (pIdx+1) + " img " + (idx+1) + " EXISTE mas CORROMPIDO — vai regerar", "warn");
                    } catch(eC) {}
                }
                if (foundValid) return;
            }

            queue.push({
                pIdx: pIdx, promptIdx: idx, prompt: prompt,
                refPath: refPath, outPath: outPathPng, folder: String(prod.folder),
                label: "p" + (pIdx+1) + " img " + (idx+1)
            });
        });
    });

    if (queue.length === 0) {
        iaLog("Nada a gerar (todas as imagens já existem ou nenhum prompt definido).", "ok");
        return;
    }

    iaLog("Iniciando geração: " + queue.length + " imagem(ns) na fila.", "info");
    iaLog("Dica: imagens podem levar 15-60s cada. Use 'Pular imagem atual' se travar.", "info");
    _iaInProgress = true;
    _iaCancelled  = false;
    _iaSkipCurrent = false;
    _iaCurrentRequest = null;
    updateIAButtonsEnabled();

    var i = 0;
    var startedAt = Date.now();
    var consecutiveErrors = 0;
    var quotaErrorCount = 0;

    function finishGeneration(reason) {
        _iaInProgress = false;
        _iaCurrentRequest = null;
        updateIAButtonsEnabled();
        if (reason) iaLog(reason, "info");
    }

    function processNext() {
        // Cancelamento pelo usuário
        if (_iaCancelled) {
            iaLog("Geração CANCELADA pelo usuário. " + (i-1) + "/" + queue.length + " imagem(ns) processada(s).", "warn");
            iaLog("Imagens já geradas foram preservadas em disco. Use 'Gerar apenas faltantes' pra retomar.", "info");
            finishGeneration();
            return;
        }

        if (i >= queue.length) {
            var elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
            iaLog("Geração concluída em " + elapsed + "s. " + queue.length + " imagem(ns) processada(s).", "ok");
            finishGeneration();
            return;
        }

        // Aborta cedo se detectou problema de quota (não adianta queimar requests)
        if (quotaErrorCount >= 2) {
            iaLog("ABORTADO: " + quotaErrorCount + " erros consecutivos de quota/billing. " +
                  "Modelo \"" + model + "\" provavelmente não está disponível no seu tier. " +
                  "Verifique billing em https://aistudio.google.com/ ou tente outro modelo.", "error");
            iaLog("Itens não processados: " + (queue.length - i + 1), "warn");
            finishGeneration();
            return;
        }

        var task = queue[i++];
        iaLog("[" + i + "/" + queue.length + "] " + task.label + ": " + task.prompt.substring(0, 60) + "...", "info");

        // Lê referência como base64
        var refBase64;
        try {
            var refBuf = fs.readFileSync(task.refPath);
            refBase64 = refBuf.toString("base64");
        } catch(eR) {
            iaLog("  err ao ler referência: " + eR.message, "error");
            setTimeout(processNext, 100);
            return;
        }

        var fullPrompt = buildReinforcedPrompt(task.prompt);
        var taskStart  = Date.now();

        // Heartbeat: a cada 15s mostra que ainda está rodando
        var hb = setInterval(function() {
            var elapsed = ((Date.now() - taskStart) / 1000).toFixed(0);
            iaLog("  ... " + task.label + " ainda processando (" + elapsed + "s)", "info");
        }, 15000);

        var hbCb = function(msg) { iaLog("  " + msg, "info"); };
        _iaCurrentRequest = generateImageWithGemini(apiKey, model, fullPrompt, refBase64, function(err, b64, mime) {
            clearInterval(hb);
            _iaCurrentRequest = null;
            var elapsed = ((Date.now() - taskStart) / 1000).toFixed(1);

            // Se foi cancelado durante esta request, encerra tudo
            if (_iaCancelled) {
                iaLog("  ✗ " + task.label + " interrompido por cancelamento (" + elapsed + "s)", "warn");
                processNext();
                return;
            }

            // Se foi pulado, marca como skip e segue pra próxima
            if (_iaSkipCurrent) {
                iaLog("  ⏭ " + task.label + " pulado pelo usuário (" + elapsed + "s)", "warn");
                _iaSkipCurrent = false;
                setTimeout(processNext, 500);
                return;
            }

            if (err) {
                var errMsg = err.message || String(err);
                iaLog("  ✗ " + task.label + " falhou: " + errMsg.substring(0, 200), "error");
                consecutiveErrors++;

                // Detecta erros permanentes (quota, billing, modelo não disponível, key inválida)
                var isPermanent = errMsg.indexOf("429") >= 0 ||
                                  errMsg.indexOf("quota") >= 0 ||
                                  errMsg.indexOf("billing") >= 0 ||
                                  errMsg.indexOf("not found") >= 0 ||
                                  errMsg.indexOf("PERMISSION_DENIED") >= 0 ||
                                  errMsg.indexOf("401") >= 0 ||
                                  errMsg.indexOf("403") >= 0;

                if (isPermanent) quotaErrorCount++;

                // Backoff maior se quota; pequeno se erro transitório
                var delay = isPermanent ? 100 : 3000;
                setTimeout(processNext, delay);
                return;
            }
            consecutiveErrors = 0;
            quotaErrorCount = 0;
            try {
                var outBuf = Buffer.from(b64, "base64");

                // Detecta o formato REAL pelos magic bytes (Gemini pode retornar
                // JPEG/WebP mesmo quando solicitamos PNG; Premiere rejeita
                // arquivo com extensão diferente do conteúdo).
                var fmt = detectImageFormat(outBuf);
                var realExt = fmt ? fmt.ext : "png";
                var realMime = fmt ? fmt.mime : "unknown";
                var realPath = task.outPath.replace(/\.png$/i, "." + realExt);

                // Mostra magic bytes pra diagnóstico
                var magic = "";
                for (var b = 0; b < Math.min(8, outBuf.length); b++) {
                    magic += (outBuf[b] < 16 ? "0" : "") + outBuf[b].toString(16) + " ";
                }
                iaLog("  magic bytes: [" + magic.trim() + "] → " + realMime + " (.​" + realExt + ")", "info");

                fs.writeFileSync(realPath, outBuf);

                // Se MIME informado pela API diferir do detectado, loga aviso
                if (mime && fmt && mime !== realMime) {
                    iaLog("  AVISO: API informou MIME=" + mime + " mas conteúdo é " + realMime, "warn");
                }

                // Se a extensão real é diferente de .png, remove arquivo .png antigo
                // (de execução anterior) pra não confundir o auto-fill
                if (realExt !== "png") {
                    try {
                        if (fs.existsSync(task.outPath)) fs.unlinkSync(task.outPath);
                    } catch(eU) {}
                }

                iaLog("  ✓ " + task.label + " → " + realPath +
                      " (" + (outBuf.length / 1024).toFixed(1) + " KB em " + elapsed + "s)", "ok");

                // Importa a imagem pro bin PROD_N do projeto (cria o bin se preciso).
                if (task.folder) {
                    var impArg = JSON.stringify(String(task.folder)) + ", " + JSON.stringify(realPath);
                    cs.evalScript("importImageToBin(" + impArg + ")", function (rImp) {
                        try {
                            var ri = JSON.parse(rImp);
                            if (ri.error) iaLog("  import pro bin PROD_" + task.folder + " falhou: " + ri.error, "warn");
                            else iaLog("  → importada pro bin PROD_" + task.folder, "info");
                        } catch (eImp) {}
                    });
                }
            } catch(eW) {
                iaLog("  err ao salvar: " + eW.message, "error");
            }
            // Espaçamento entre requests pra respeitar rate limit (free tier ~10/min)
            setTimeout(processNext, 1500);
        }, hbCb);
    }

    processNext();
}

// ─── PERSISTÊNCIA POR PROJETO ─────────────────────────────────────────────────

function initProjectPersistence() {
    cs.evalScript("getProjectPath()", function (raw) {
        try {
            var data = JSON.parse(raw);
            var projectPath = data.path || "";
            _projectKey = "autoeditor_" + projectPath;
            restoreProjectPaths();
        } catch(e) { /* usa chave default */ }
    });
}

function saveProjectData() {
    var data = {
        transcriptPath:  _savedTranscriptPath || "",
        jsonPath:        _savedJsonPath       || "",
        createdProducts: _createdProducts.slice() // [1, 2, 3, ...]
    };
    try { localStorage.setItem(_projectKey, JSON.stringify(data)); } catch(e) {}
}

function restoreProjectPaths() {
    try {
        var raw = localStorage.getItem(_projectKey);
        if (!raw) return;
        var data = JSON.parse(raw);

        // Transcrição
        if (data.transcriptPath) {
            _savedTranscriptPath = data.transcriptPath;
            _autoLoadFile(data.transcriptPath, function(content) {
                loadTranscriptContent(content, data.transcriptPath);
            });
        }

        // Produtos já criados — restaura os cards no estado colapsado (só "+ ARQUIVO")
        if (data.createdProducts && data.createdProducts.length) {
            _createdProducts = data.createdProducts.slice();
            _createdProducts.forEach(function(n) {
                renderProductCard(n, { restored: true });
            });
        }

        // JSON de mapeamento
        if (data.jsonPath) {
            _savedJsonPath = data.jsonPath;
            _autoLoadFile(data.jsonPath, function(content) {
                try {
                    loadedJSON = JSON.parse(content);
                    document.getElementById("json-path").value = data.jsonPath;
                    updateMountButton();
                    if (typeof updateIAButtonsEnabled === "function") updateIAButtonsEnabled();
                    var isMulti = !!(loadedJSON.products && loadedJSON.products.length);
                    if (isMulti) {
                        var total = loadedJSON.products.reduce(function(acc, p) { return acc + (p.timeline || []).length; }, 0);
                        log("JSON restaurado: " + loadedJSON.products.length + " produto(s), " + total + " item(s).", "ok");
                    }
                } catch(e) { log("Falha ao restaurar JSON: " + e.message, "warn"); }
            });
        }
    } catch(e) { /* silencioso */ }
}

// Lê arquivo via ExtendScript (suporta qualquer path local)
function _autoLoadFile(filePath, callback) {
    var escaped = filePath.replace(/\\/g, "\\\\");
    cs.evalScript('readFileContent("' + escaped + '", "UTF-8")', function(raw) {
        try {
            var data = JSON.parse(raw);
            if (data.error) { log("Não foi possível restaurar: " + filePath.split("\\").pop(), "warn"); return; }
            var content = data.content;
            // Detecta encoding errado e recarrega como windows-1252 se necessário
            var badChars = (content.match(/�/g) || []).length;
            if (badChars > 2) {
                cs.evalScript('readFileContent("' + escaped + '", "Windows-1252")', function(raw2) {
                    try { var d2 = JSON.parse(raw2); if (d2.content) callback(d2.content); } catch(e) {}
                });
            } else {
                callback(content);
            }
        } catch(e) {}
    });
}

// Caminhos salvos das últimas seleções
var _savedTranscriptPath = "";
var _savedJsonPath       = "";

function refreshSequenceInfo() {
    cs.evalScript("ping()", function (raw) {
        try {
            var data = JSON.parse(raw);
            var el = document.getElementById("seq-name");
            if (data.ok && data.sequence) {
                el.textContent = data.sequence;
                el.classList.remove("error");
            } else {
                el.textContent = "Nenhuma sequência ativa";
                el.classList.add("error");
            }
        } catch (e) {
            document.getElementById("seq-name").textContent = "Erro de conexão";
        }
    });
}

function openJSONPicker() {
    var input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = function (e) {
        var file = e.target.files[0];
        if (!file) return;
        var filePath = file.path || file.name;
        readTextWithEncodingFallback(file, function (content) {
            try { _applyMappingContent(content, filePath); }
            catch (err) { log("JSON inválido: " + err.message, "error"); }
        });
    };
    input.click();
}

// Aplica o conteúdo de um JSON de mapeamento ao estado + UI. Lança se o JSON
// for inválido (o chamador trata). Compartilhado entre o seletor de arquivo e
// o carregamento automático pela pasta do projeto.
function _applyMappingContent(content, filePath) {
    loadedJSON = JSON.parse(content);
    document.getElementById("json-path").value = filePath;
    updateMountButton();
    if (typeof updateIAButtonsEnabled === "function") updateIAButtonsEnabled();
    var isMulti = !!(loadedJSON.products && loadedJSON.products.length);
    if (isMulti) {
        var total = loadedJSON.products.reduce(function (acc, p) { return acc + (p.timeline || []).length; }, 0);
        log("JSON carregado: " + loadedJSON.products.length + " produto(s), " + total + " item(s) na timeline.", "ok");
    } else {
        log("JSON carregado: " + (loadedJSON.timeline || []).length + " item(s) na timeline.", "ok");
    }
    _savedJsonPath = filePath;
    saveProjectData();
}

// Carrega automaticamente o JSON de mapeamento (*_autoeditor.json) E a
// transcrição (.json do Premiere) da PASTA do projeto. Pega o mais recente de
// cada tipo; identifica por nome ("autoeditor" = mapeamento) e valida a
// transcrição pelo conteúdo (precisa parsear como JSON de palavras do Premiere).
function loadJSONsFromProjectFolder() {
    var btn = document.getElementById("btn-load-from-folder");
    if (btn) { btn.disabled = true; }
    function reenable() { if (btn) btn.disabled = false; }

    cs.evalScript("getProjectDir()", function (rawPrj) {
        var prjDir = "";
        try { var rp = JSON.parse(rawPrj); prjDir = rp.dir || ""; } catch (e) {}
        if (!prjDir) { log("Salve o projeto primeiro — preciso da pasta do .prproj pra buscar os JSONs.", "error"); reenable(); return; }

        var fs = tryNodeRequire('fs'), pmod = tryNodeRequire('path');
        if (!fs || !pmod) { log("Node indisponível pra listar a pasta.", "error"); reenable(); return; }

        var names;
        try { names = fs.readdirSync(prjDir); } catch (e) { log("Não consegui ler a pasta do projeto: " + e.message, "error"); reenable(); return; }

        var jsons = [];
        names.forEach(function (n) {
            if (!/\.json$/i.test(n)) return;
            var p = pmod.join(prjDir, n), m = 0;
            try { m = fs.statSync(p).mtimeMs; } catch (e) {}
            jsons.push({ name: n, path: p, mtime: m });
        });
        if (!jsons.length) { log("Nenhum .json encontrado na pasta do projeto: " + prjDir, "warn"); reenable(); return; }

        jsons.sort(function (a, b) { return b.mtime - a.mtime; }); // mais recente primeiro
        var mapFile  = jsons.filter(function (j) { return /autoeditor/i.test(j.name); })[0] || null;
        var trCands  = jsons.filter(function (j) { return !/autoeditor/i.test(j.name); });

        log("Pasta do projeto: " + jsons.length + " .json — buscando mapeamento e transcrição…");

        // 1) Mapeamento (se houver) → 2) Transcrição (1ª candidata que validar).
        if (mapFile) {
            _autoLoadFile(mapFile.path, function (content) {
                try { _applyMappingContent(content, mapFile.path); }
                catch (e) { log("JSON de mapeamento inválido (" + mapFile.name + "): " + e.message, "error"); }
                pickTranscript(0);
            });
        } else {
            log("Nenhum *_autoeditor.json na pasta — pulei o mapeamento.", "warn");
            pickTranscript(0);
        }

        // Tenta cada candidato (mais recente primeiro) até um parsear como transcrição.
        function pickTranscript(idx) {
            if (idx >= trCands.length) {
                log(trCands.length ? "Nenhum .json da pasta parseou como transcrição do Premiere." : "Nenhum .json de transcrição na pasta.", "warn");
                reenable();
                return;
            }
            var cand = trCands[idx];
            _autoLoadFile(cand.path, function (content) {
                var ok = false;
                try { ok = parsePremierTranscriptJSON(content).length > 0; } catch (e) { ok = false; }
                if (ok) {
                    loadTranscriptContent(content, cand.path);
                    _savedTranscriptPath = cand.path;
                    saveProjectData();
                    reenable();
                } else {
                    pickTranscript(idx + 1);
                }
            });
        }
    });
}

// Lê um arquivo como texto. Se detectar caracteres de substituição (encoding errado),
// tenta novamente como Windows-1252 — comum quando arquivos são salvos no Bloco de Notas.
function readTextWithEncodingFallback(file, callback) {
    var r = new FileReader();
    r.onload = function (ev) {
        var content = ev.target.result;
        var badChars = (content.match(/�/g) || []).length;
        if (badChars > 2) {
            var r2 = new FileReader();
            r2.onload = function (ev2) { callback(ev2.target.result); };
            r2.readAsText(file, "windows-1252");
        } else {
            callback(content);
        }
    };
    r.readAsText(file);
}

// Processa o conteúdo de uma transcrição (JSON ou SRT) e atualiza o estado
function loadTranscriptContent(content, filePath) {
    var statusEl = document.getElementById("srt-status");
    var isJSON = filePath && (filePath.toLowerCase().endsWith(".json") || content.trimLeft().charAt(0) === "{");
    if (isJSON) {
        try {
            var words = parsePremierTranscriptJSON(content);
            if (words.length === 0) throw new Error("Nenhuma palavra encontrada.");
            transcriptWords = words;
            srtEntries     = [];
            statusEl.textContent = words.length + " palavras (JSON Premiere)";
            statusEl.className   = "badge ok";
            log("Transcrição JSON carregada: " + words.length + " palavras com timestamps precisos.", "ok");
        } catch (err) {
            statusEl.textContent = "JSON inválido";
            statusEl.className   = "badge error";
            log("Erro ao parsear transcrição: " + err.message, "error");
        }
    } else {
        srtEntries     = parseSRT(content);
        transcriptWords = [];
        statusEl.textContent = srtEntries.length + " entradas (SRT)";
        statusEl.className   = "badge ok";
        log("SRT carregado: " + srtEntries.length + " entradas.", "ok");
    }
    updateMountButton();
}

function openSRTPicker() {
    var input = document.createElement("input");
    input.type = "file";
    input.accept = ".srt,.vtt,.json";
    input.onchange = function (e) {
        var file = e.target.files[0];
        if (!file) return;
        var filePath = file.path || file.name;
        var reader = new FileReader();
        reader.onload = function (ev) {
            loadTranscriptContent(ev.target.result, filePath);
            _savedTranscriptPath = filePath;
            saveProjectData();
        };
        reader.readAsText(file);
    };
    input.click();
}

function exportSRTFromPremiere() {
    var btn = document.getElementById("btn-export-srt");
    var statusEl = document.getElementById("srt-status");
    log("Importando transcrição da sequência ativa…", "info");
    if (btn) btn.disabled = true;

    cs.evalScript("getTempFolder()", function (raw) {
        var tempFolder = String(raw || "").replace(/^"|"$/g, "").replace(/\\\\/g, "\\");
        if (!tempFolder) {
            log("Não consegui resolver a pasta temporária.", "error");
            if (btn) btn.disabled = false;
            return;
        }
        var srtPath = tempFolder + "\\autoeditor_transcription.srt";
        var escaped = srtPath.replace(/\\/g, "\\\\");

        cs.evalScript('exportTranscription("' + escaped + '")', function (result) {
            if (btn) btn.disabled = false;
            var data = null;
            try { data = JSON.parse(result); } catch (e) {
                log("Resposta inválida do host: " + result, "error");
                return;
            }
            if (!data || data.error) {
                log(data && data.error ? data.error : "Falha desconhecida.", "error");
                if (data && data.attempts && data.attempts.length) {
                    log("Tentativas: " + data.attempts.join(" | "), "info");
                }
                if (statusEl) {
                    statusEl.textContent = "Falhou — veja log";
                    statusEl.className = "badge error";
                }
                return;
            }
            // Sucesso: reusa o mesmo fluxo do "Carregar arquivo" pra
            // manter status/estado consistente.
            loadTranscriptContent(data.content, srtPath);
            log("Transcrição importada da sequência (" + (data.hasCaptions ? "via captions" : "via fallback") + ").", "ok");
        });
    });
}

function updateMountButton() {
    var hasJSON    = !!loadedJSON;
    var btn        = document.getElementById("btn-mount");
    btn.disabled   = !hasJSON;
    btn.title      = hasJSON ? "" : "Carregue o JSON de mapeamento antes de montar";
}


// ─── PATCH PRPROJ (Node.js) ───────────────────────────────────────────────────
// O Source Text do Essential Graphics não é exposto via ExtendScript no PPRO 2025.
// Alternativa: ler o prproj (XML gzip), substituir os placeholders diretamente
// no XML, salvar um arquivo temporário, e importá-lo de volta no Premiere.

function tryNodeRequire(mod) {
    try { return require(mod); } catch(e) { return null; }
}

// Tenta ler e descomprimir o prproj via Node.js.
// Retorna { xml: string } se bem-sucedido, ou { error: string }.
function readPrprojXML(prprojPath) {
    var fs   = tryNodeRequire('fs');
    var zlib = tryNodeRequire('zlib');
    if (!fs || !zlib) return { error: 'Node.js não disponível neste contexto CEP' };
    try {
        var buf = fs.readFileSync(prprojPath);
        var xml;
        try {
            xml = zlib.gunzipSync(buf).toString('utf8');
        } catch(eGz) {
            xml = buf.toString('utf8'); // não comprimido
        }
        return { xml: xml };
    } catch(e) {
        return { error: e.message };
    }
}

// Escreve o XML de volta como prproj gzipado. Sobrescreve o arquivo.
function writePrprojXML(prprojPath, xml) {
    var fs   = tryNodeRequire('fs');
    var zlib = tryNodeRequire('zlib');
    if (!fs || !zlib) return { error: 'Node.js não disponível neste contexto CEP' };
    try {
        var outBuf = zlib.gzipSync(Buffer.from(xml, 'utf8'));
        fs.writeFileSync(prprojPath, outBuf);
        return { ok: true };
    } catch(e) {
        return { error: e.message };
    }
}

// Computa o nome canônico da cópia de um template para um produto,
// usando a MESMA fórmula do ExtendScript (insertTemplate).
function computeCopyName(templateLogicalName, product, extraSuffix) {
    var label = ((product.brand || '') + '_' + (product.name || ''))
        .replace(/[^a-zA-Z0-9_]/g, '_')
        .replace(/_+/g, '_')
        .substring(0, 30);
    var suffix = extraSuffix ? '_' + extraSuffix : '';
    return '[' + templateLogicalName + '] ' + label + suffix;
}

// ─── PATCH BINÁRIO DO SOURCE TEXT EG ─────────────────────────────────────────
// O texto real do Essential Graphics fica em <PremiereFilterPrivateData Encoding="base64">
// como binário serializado, NÃO como texto plain no XML.
// Estas funções decodificam o base64, substituem o texto no binário (ASCII ou UTF-16LE),
// corrigem o campo de comprimento int32-LE, e re-encodificam.

// Substitui `placeholder` por `newText` dentro de uma string binária (latin-1).
// Tenta ASCII (E1), UTF-16LE (E2), UTF-16BE (E3).
// IMPORTANTE: o blob resultante tem o MESMO TAMANHO do original (null-padding).
// Mudar o tamanho crasheia o Premiere (buffer overread no parser C++).
// O renderizador de texto do AE/PPRO para no primeiro \x00, então
// "R$ 330\x00\x00..." renderiza como "R$ 330".
// Retorna { result, encoding } — encoding é null se não encontrou.
function patchBinaryText(binStr, placeholder, newText) {
    // Preenche str com \x00 até targetLen (ou trunca se maior)
    function padNull(str, targetLen) {
        if (str.length >= targetLen) return str.substring(0, targetLen);
        var r = str;
        while (r.length < targetLen) r += '\x00';
        return r;
    }

    // E1: ASCII
    var idx1 = binStr.indexOf(placeholder);
    if (idx1 >= 0) {
        var r1 = binStr.substring(0, idx1) +
                 padNull(newText, placeholder.length) +
                 binStr.substring(idx1 + placeholder.length);
        return { result: r1, encoding: 'ASCII' };
    }

    // E2: UTF-16LE  (char + \x00)
    var ph16 = '', nt16 = '';
    for (var i = 0; i < placeholder.length; i++) ph16 += placeholder[i] + '\x00';
    for (var j = 0; j < newText.length;     j++) nt16 += newText[j]     + '\x00';
    var i16 = binStr.indexOf(ph16);
    if (i16 >= 0) {
        var r16 = binStr.substring(0, i16) +
                  padNull(nt16, ph16.length) +
                  binStr.substring(i16 + ph16.length);
        return { result: r16, encoding: 'UTF-16LE' };
    }

    // E3: UTF-16BE  (\x00 + char)
    var phBE = '', ntBE = '';
    for (var k = 0; k < placeholder.length; k++) phBE += '\x00' + placeholder[k];
    for (var m = 0; m < newText.length;     m++) ntBE += '\x00' + newText[m];
    var iBE = binStr.indexOf(phBE);
    if (iBE >= 0) {
        var rBE = binStr.substring(0, iBE) +
                  padNull(ntBE, phBE.length) +
                  binStr.substring(iBE + phBE.length);
        return { result: rBE, encoding: 'UTF-16BE' };
    }

    return { result: binStr, encoding: null }; // não encontrou
}

// Diagnóstico: varre TODOS os blobs <PremiereFilterPrivateData Encoding="base64"> no XML
// e mostra quais contêm o placeholder e em qual encoding.
// Chame apenas para o primeiro produto (passa logFn = log ou null).
function diagnosePFPDBlobs(xml, placeholder, logFn) {
    if (!logFn) return;
    var PFPD_S = '<PremiereFilterPrivateData';
    var PFPD_C = '</PremiereFilterPrivateData>';
    var from = 0, blobN = 0;
    while (blobN < 30) {
        var pfI = xml.indexOf(PFPD_S, from);
        if (pfI < 0) break;
        var tagEnd = xml.indexOf('>', pfI);
        if (tagEnd < 0) { from = pfI+1; continue; }
        if (xml.substring(pfI, tagEnd).toLowerCase().indexOf('base64') < 0) { from = pfI+1; continue; }
        var dS = tagEnd+1, dE = xml.indexOf(PFPD_C, dS);
        if (dE < 0) { from = pfI+1; continue; }
        blobN++;
        var b64 = xml.substring(dS, dE).replace(/\s/g, '');
        try {
            var bin = Buffer.from(b64, 'base64').toString('binary');
            var res = patchBinaryText(bin, placeholder, placeholder); // dry-run: substitui por si mesmo
            if (res.encoding) {
                logFn('[PFPD #' + blobN + '] @' + pfI + ' sz=' + bin.length + ' → encontrado como ' + res.encoding + ' ✓', 'ok');
            } else {
                // Mostra primeiros 120 chars legíveis para diagnóstico
                var readable = '';
                for (var rb = 0; rb < Math.min(300, bin.length); rb++) {
                    var cc = bin.charCodeAt(rb);
                    readable += (cc >= 32 && cc < 127) ? bin[rb] : '.';
                }
                logFn('[PFPD #' + blobN + '] @' + pfI + ' sz=' + bin.length + ' readable: ' + readable.replace(/\.{3,}/g, '···'), 'info');
            }
        } catch(eBD) {
            logFn('[PFPD #' + blobN + '] decode err: ' + eBD.message, 'warn');
        }
        from = dE+1;
    }
    if (blobN === 0) logFn('[PFPD diag] nenhum blob base64 encontrado', 'warn');
}

// Varre TODOS os elementos com Encoding="base64" no XML (incluindo <StartKeyframeValue>,
// <PremiereFilterPrivateData>, etc.), decodifica cada blob, tenta encontrar o placeholder
// como bytes ASCII, substitui e re-encoda. Ignora tags self-closing e blobs triviais.
// O texto real do EG Source Text fica em <ArbVideoComponentParam> → <StartKeyframeValue>.
function patchEGBlobsInXML(xml, placeholder, newText) {
    var ENCB64 = 'Encoding="base64"';
    var result = xml;
    var from   = 0;

    while (true) {
        // Encontra próximo atributo Encoding="base64"
        var attrIdx = result.indexOf(ENCB64, from);
        if (attrIdx < 0) break;

        // Fim da tag de abertura
        var tagEnd = result.indexOf('>', attrIdx);
        if (tagEnd < 0) { from = attrIdx + 1; continue; }

        // Pula self-closing tags (sem conteúdo)
        if (result[tagEnd - 1] === '/') { from = tagEnd + 1; continue; }

        // Retrocede para encontrar o nome do elemento
        var tagStart   = result.lastIndexOf('<', attrIdx);
        if (tagStart < 0) { from = tagEnd + 1; continue; }
        var spaceAfter = result.indexOf(' ', tagStart + 1);
        if (spaceAfter < 0 || spaceAfter > tagEnd) { from = tagEnd + 1; continue; }
        var elemName   = result.substring(tagStart + 1, spaceAfter);
        if (!elemName || elemName.indexOf('<') >= 0 || elemName.indexOf('>') >= 0) { from = tagEnd + 1; continue; }

        var closingTag = '</' + elemName + '>';
        var dStart     = tagEnd + 1;
        var dEnd       = result.indexOf(closingTag, dStart);
        if (dEnd < 0) { from = tagEnd + 1; continue; }

        var b64 = result.substring(dStart, dEnd).replace(/\s/g, '');
        if (b64.length < 8) { from = dEnd + 1; continue; } // ignora blobs triviais (AA==, etc.)

        try {
            var decoded  = Buffer.from(b64, 'base64').toString('binary');
            var patchRes = patchBinaryText(decoded, placeholder, newText);
            if (patchRes.encoding) {
                var newB64 = Buffer.from(patchRes.result, 'binary').toString('base64');
                result = result.substring(0, dStart) + newB64 + result.substring(dEnd);
                from   = dStart + newB64.length;
            } else {
                from = dEnd + 1;
            }
        } catch(eBuf) {
            from = dEnd + 1;
        }
    }
    return result;
}

// Extrai os blobs EG (348 bytes de TextDocument serializado) onde cada placeholder aparece,
// e retorna versões PATCHADAS (com o texto substituído, null-padded, mantendo o tamanho).
// O texto é retornado em base64 para ser passado via cs.evalScript ao ExtendScript.
//
// Por que isso é necessário: getValue() no ExtendScript retorna APENAS os bytes do texto
// (ex: 21 bytes para "[[PRODUCT_PRICE_MIN]]"), perdendo a estrutura TextDocument completa.
// setValue() com uma string curta destrói o estilo. A solução é setValue() com o BLOB
// completo de 348 bytes (com texto patched), preservando todo o restante (fonte, cor, etc).
//
// Retorna: { '[[PRODUCT_PRICE_MIN]]': '<base64-348b>', '[[PRODUCT_PRICE_MAX]]': '...', ... }
function extractPatchedEGBlobsForProduct(xml, product) {
    function priceNum(val) {
        return formatPriceByLang(val, loadedJSON && loadedJSON.language);
    }
    var pairs = [
        ['[[PRODUCT_PRICE_MIN]]', priceNum(product.price_min || product.price)],
        ['[[PRODUCT_PRICE_MAX]]', priceNum(product.price_max || product.price)],
        ['[[PRODUCT_PRICE]]',     priceNum(product.price)],
        ['[[PRODUCT_NAME]]',      product.name  || ''],
        ['[[PRODUCT_BRAND]]',     product.brand || '']
    ];

    var result = {};
    var ENCB64 = 'Encoding="base64"';

    pairs.forEach(function(pp) {
        var placeholder = pp[0];
        var newText     = pp[1];
        if (!newText) return;

        var from = 0;
        while (true) {
            var attrIdx = xml.indexOf(ENCB64, from);
            if (attrIdx < 0) break;
            var tagEnd = xml.indexOf('>', attrIdx);
            if (tagEnd < 0) { from = attrIdx + 1; continue; }
            if (xml[tagEnd - 1] === '/') { from = tagEnd + 1; continue; }
            var tagStart   = xml.lastIndexOf('<', attrIdx);
            if (tagStart < 0) { from = tagEnd + 1; continue; }
            var spaceAfter = xml.indexOf(' ', tagStart + 1);
            if (spaceAfter < 0 || spaceAfter > tagEnd) { from = tagEnd + 1; continue; }
            var elemName   = xml.substring(tagStart + 1, spaceAfter);
            if (!elemName || elemName.indexOf('<') >= 0) { from = tagEnd + 1; continue; }
            var closingTag = '</' + elemName + '>';
            var dStart     = tagEnd + 1;
            var dEnd       = xml.indexOf(closingTag, dStart);
            if (dEnd < 0) { from = tagEnd + 1; continue; }
            var b64 = xml.substring(dStart, dEnd).replace(/\s/g, '');
            if (b64.length < 8) { from = dEnd + 1; continue; }

            try {
                var decoded  = Buffer.from(b64, 'base64').toString('binary');
                // Verifica se este blob contém o placeholder (em qualquer encoding)
                var patchRes = patchBinaryText(decoded, placeholder, newText);
                if (patchRes.encoding) {
                    // Encontrou! Re-encoda o blob patched e salva
                    var patchedB64 = Buffer.from(patchRes.result, 'binary').toString('base64');
                    result[placeholder] = patchedB64;
                    break; // Um blob por placeholder
                }
            } catch(eB) { /* ignora */ }
            from = dEnd + 1;
        }
    });

    return result;
}

// ─── GUID REGENERATION ───────────────────────────────────────────────────────
// Gera um GUID aleatório no formato xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
function generateGUID() {
    var h = '0123456789abcdef';
    function s(n) {
        var r = '';
        for (var i = 0; i < n; i++) r += h[Math.floor(Math.random() * 16)];
        return r;
    }
    return s(8) + '-' + s(4) + '-' + s(4) + '-' + s(4) + '-' + s(12);
}

// Para cada rename em renames, encontra a <Sequence> pelo nome ORIGINAL (r.from)
// e substitui o ObjectURef (GUID) por um GUID novo — ANTES do rename de nomes.
// Estratégia: busca <Name>r.from</Name> no XML, depois busca REVERSA pelo
// <Sequence ObjectURef="..."> mais próximo antes dessa tag <Name>.
// Isso evita o problema de janela de 2000 chars (o <Name> pode estar muito longe
// do <Sequence> no prproj), e usa o nome original que é único no arquivo.
function reguidSequences(xml, renames) {
    var result = xml;
    var processed = {};
    (renames || []).forEach(function(r) {
        // Deduplicação por r.to: cada sequência de destino é reguideada só uma vez
        if (processed[r.to]) return;

        // Itera sobre TODAS as ocorrências de <Name>r.from</Name>.
        // A primeira pode estar num project-item (bin), não na sequence — continua.
        var nameTag  = '<Name>' + r.from + '</Name>';
        var searchFrom = 0;
        var foundGUID = false;

        while (true) {
            var nameIdx = result.indexOf(nameTag, searchFrom);
            if (nameIdx < 0) break; // nenhuma ocorrência restante

            // Busca reversa: último elemento container (MasterClip ou Sequence) antes de <Name>
            // Em versões recentes do Premiere Pro, sequences são <MasterClip ObjectUID="...">
            // Em versões mais antigas podem ser <Sequence ObjectURef="...">
            var before     = result.substring(0, nameIdx);
            var clipStart  = before.lastIndexOf('<MasterClip ');
            var seqStart2  = before.lastIndexOf('<Sequence ');
            var elemStart  = Math.max(clipStart, seqStart2);
            var elemName   = (clipStart >= seqStart2) ? 'MasterClip' : 'Sequence';
            var closingTag = '</' + elemName + '>';

            if (elemStart >= 0) {
                // Verifica que o elemento não fechou antes de <Name>
                var between = result.substring(elemStart, nameIdx);
                if (between.indexOf(closingTag) < 0) {
                    // Extrai o ID (ObjectUID para MasterClip, ObjectURef para Sequence)
                    var elemTagEnd = result.indexOf('>', elemStart);
                    if (elemTagEnd >= 0) {
                        var elemTag   = result.substring(elemStart, elemTagEnd + 1);
                        // Aceita ObjectUID (MasterClip) OU ObjectURef (Sequence)
                        var uidMatch  = elemTag.match(/Object(?:UID|URef)="([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i);
                        if (uidMatch) {
                            processed[r.to] = true;
                            var oldGUID = uidMatch[1];
                            var newGUID = generateGUID();
                            // Substitui TODAS as ocorrências (referências cruzadas)
                            result = result.split(oldGUID).join(newGUID);
                            log('reguid [' + elemName + ']: ' + r.from + ' → ' + r.to + ' | ' + oldGUID + ' → ' + newGUID, 'info');
                            foundGUID = true;
                            break;
                        }
                    }
                }
            }

            searchFrom = nameIdx + nameTag.length; // avança para próxima ocorrência
        }

        if (!foundGUID && !processed[r.to]) {
            log('reguid WARN: não encontrou MasterClip/Sequence para "' + r.from + '"', 'warn');
        }
    });
    return result;
}

// ─── PATCH DO PRPROJ POR PRODUTO ─────────────────────────────────────────────
// 1. Patcha blobs binários <StartKeyframeValue> (Source Text EG / mogrt)
// 2. Substitui placeholders em tags Name/InstanceName (texto plano)
// 3. Regenera GUIDs das sequences (busca pelo nome original r.from — antes do rename)
// 4. Renomeia cada sequence de template para o nome único por produto
// templateRenames = [{ from: '[TEMPLATE]PRECO', to: '[PRECO] WAP_...' }, ...]
// templateSeqIDs  = { '[TEMPLATE]PRECO': 'eeeab5ff-...', ... }  (do getTemplateSequenceIDs)
function patchPrprojForProduct(prprojPath, product, tempSuffix, templateRenames, templateSeqIDs) {
    var res = readPrprojXML(prprojPath);
    if (res.error) return { error: res.error };

    var xml     = res.xml;
    var changed = false;
    var found   = [];

    // 0. Substitui TODAS as ObjectUIDs (GUIDs de instância) por novos GUIDs, mantendo
    //    o mapeamento consistente (toda ref para um ObjectUID antigo vira o novo).
    //
    //    Por que isto é necessário: o Premiere considera duplicados ao importar um prproj
    //    quando os MasterClips dependentes (mídia, gráficos, etc) já existem no projeto
    //    aberto — mesmo que tenhamos trocado o ObjectUID das sequências template. Como o
    //    [TEMPLATE]PRECO referencia o MasterClip "Graphic" e o PREÇO.mp4 com ObjectURef
    //    inalterados, o Premiere vê "ah, já tenho esses MasterClips" e ignora tudo.
    //
    //    A solução: regenerar TODOS os ObjectUIDs (e suas referências) — o temp prproj
    //    vira efetivamente um projeto totalmente novo com os mesmos dados. ClassIDs
    //    são preservados pois nunca aparecem como ObjectUID="..." (são tipo, não instância).
    (function() {
        // Encontra todos os ObjectUID="xxx" (valores únicos, instance IDs)
        var uidRe = /ObjectUID="([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/gi;
        var uniqueUIDs = {};
        var m;
        while ((m = uidRe.exec(xml)) !== null) {
            uniqueUIDs[m[1].toLowerCase()] = true;
        }
        var uidList = [];
        for (var k in uniqueUIDs) if (uniqueUIDs.hasOwnProperty(k)) uidList.push(k);

        if (uidList.length === 0) {
            found.push('reuid: 0 ObjectUIDs encontrados (nada a fazer)');
            return;
        }

        // Para eficiência, fazemos um único passe: gera mapping antigo→novo, depois aplica
        // via regex global em vez de N chamadas split/join.
        var mapping = {};
        for (var i = 0; i < uidList.length; i++) mapping[uidList[i]] = generateGUID();

        // Regex que casa qualquer GUID e, se estiver no mapping, substitui
        var guidRe = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
        var replaced = 0;
        xml = xml.replace(guidRe, function(match, g) {
            var lc = g.toLowerCase();
            if (mapping.hasOwnProperty(lc)) {
                replaced++;
                return mapping[lc];
            }
            return match; // mantém (provavelmente ClassID)
        });
        found.push('reuid: ' + uidList.length + ' UIDs únicos, ' + replaced + ' substituições');
    })();

    // Formata o número do preço conforme o idioma (ponto/vírgula) e remove a moeda.
    function priceNum(val) {
        return formatPriceByLang(val, loadedJSON && loadedJSON.language);
    }
    var pairs = [
        ['[[PRODUCT_PRICE_MIN]]', priceNum(product.price_min || product.price)],
        ['[[PRODUCT_PRICE_MAX]]', priceNum(product.price_max || product.price)],
        ['[[PRODUCT_PRICE]]',     priceNum(product.price)],
        ['[[PRODUCT_NAME]]',      product.name  || ''],
        ['[[PRODUCT_BRAND]]',     product.brand || '']
    ];

    // 1. Patch dos blobs binários (Source Text real do EG em <StartKeyframeValue>)
    //    DEVE ocorrer ANTES de substituir InstanceName no XML.
    //    NOTA: NÃO usamos xml.indexOf(p[0]) como guarda aqui porque placeholders
    //    em .mogrt (ex: [[PRODUCT_BRAND]], [[PRODUCT_NAME]]) ficam SOMENTE dentro
    //    de blobs base64 como UTF-16LE — nunca aparecem como texto ASCII no XML.
    //    Varrer todos os blobs é obrigatório para encontrá-los.
    pairs.forEach(function(p) {
        var patched = patchEGBlobsInXML(xml, p[0], p[1]);
        if (patched !== xml) {
            xml = patched;
            found.push('EG-bin: ' + p[0] + ' → ' + p[1]);
            changed = true;
        }
    });

    // 2. Substituições de texto plano (Name, InstanceName, metadados)
    pairs.forEach(function(p) {
        if (xml.indexOf(p[0]) >= 0) {
            xml     = xml.split(p[0]).join(p[1]);
            changed = true;
            found.push(p[0] + ' → ' + p[1]);
        }
    });

    // 3. Regenera GUIDs ANTES do rename — busca pelo nome ORIGINAL (r.from) que ainda
    //    está intacto no XML. Após o rename as tags <Name> mudariam, tornando a busca
    //    ambígua. O novo GUID faz o Premiere importar as sequências como novas entidades
    //    (sem conflito de ObjectURef com sequências já existentes no projeto).
    if (templateRenames && templateRenames.length > 0) {
        xml = reguidSequences(xml, templateRenames);
    }

    // 4. Renomeia as sequences de template para nomes únicos por produto
    (templateRenames || []).forEach(function(r) {
        if (xml.indexOf(r.from) >= 0) {
            xml = xml.split(r.from).join(r.to);
            found.push('rename: ' + r.from + ' → ' + r.to);
            changed = true;
        }
    });

    // 5. Substitui os sequenceIDs reais (Sequence.sequenceID do ExtendScript) por novos GUIDs.
    //    Este é o campo que o Premiere usa para detectar duplicatas ao importar.
    //    MasterClip.ObjectUID ≠ sequenceID — são valores diferentes; os IDs aqui vêm de
    //    getTemplateSequenceIDs() chamado antes do patch.
    if (templateSeqIDs) {
        var seqIDsReplaced = [];
        // Monta lista de pares únicos (from → to) a partir dos renames
        var processedSeqIDs = {};
        (templateRenames || []).forEach(function(r) {
            // Normaliza o nome do template (remove espaço após [TEMPLATE])
            var normFrom = r.from; // e.g. '[TEMPLATE]PRECO' ou '[TEMPLATE] PRECO'
            if (processedSeqIDs[normFrom]) return;
            // Procura o sequenceID para este template name (tenta com e sem espaço)
            var oldSeqID = templateSeqIDs[normFrom]
                        || templateSeqIDs[normFrom.replace('[TEMPLATE] ', '[TEMPLATE]')]
                        || templateSeqIDs[normFrom.replace('[TEMPLATE]', '[TEMPLATE] ')];
            if (oldSeqID && xml.indexOf(oldSeqID) >= 0) {
                processedSeqIDs[normFrom] = true;
                var newSeqID = generateGUID();
                xml = xml.split(oldSeqID).join(newSeqID);
                found.push('seqID: ' + r.from + ' | ' + oldSeqID + ' → ' + newSeqID);
                seqIDsReplaced.push(oldSeqID);
            }
        });
        if (seqIDsReplaced.length === 0) {
            found.push('seqID: nenhum sequenceID encontrado no XML (serão importados via nome)');
        }
    }

    if (!changed) return { error: 'Nenhum placeholder encontrado no prproj como texto legível' };

    var fs   = tryNodeRequire('fs');
    var zlib = tryNodeRequire('zlib');
    var tempPath = prprojPath.replace(/\.prproj$/i, '') + '_ae_temp_' + tempSuffix + '.prproj';
    try {
        var outBuf = zlib.gzipSync(Buffer.from(xml, 'utf8'));
        fs.writeFileSync(tempPath, outBuf);
    } catch(eWrite) {
        try { fs.writeFileSync(tempPath, xml); } catch(e2) { return { error: e2.message }; }
    }
    return { tempPath: tempPath, found: found };
}

// Realiza a montagem usando patch de prproj para template_insert com texto.
// Se o prproj patching funcionar, as sequências são importadas com texto correto.
// Caso contrário, cai para o fluxo normal (sem substituição de texto).
function mountWithPrprojPatch(mountData, products, btn) {
    // 1. Salva o projeto e obtém o path do prproj
    cs.evalScript('saveProjectAndGetPath()', function(raw) {
        var prprojPath = '';
        try { prprojPath = JSON.parse(raw).path || ''; } catch(e) {}

        if (!prprojPath) {
            log('Projeto não salvo em disco — patch de prproj indisponível. Prosseguindo sem substituição de texto.', 'warn');
            doMount(mountData, btn);
            return;
        }

        // 2. Verifica se Node.js está disponível e se o prproj é legível
        var testRead = readPrprojXML(prprojPath);
        if (testRead.error) {
            log('prproj: ' + testRead.error + ' — prosseguindo sem patch.', 'warn');
            doMount(mountData, btn);
            return;
        }

        var xml = testRead.xml;
        var hasPlaceholder = xml.indexOf('[[PRODUCT_PRICE') >= 0 ||
                             xml.indexOf('[[PRODUCT_NAME') >= 0  ||
                             xml.indexOf('[[PRODUCT_BRAND') >= 0;

        if (!hasPlaceholder) {
            log('prproj: placeholders não encontrados como texto legível (formato binário interno). Prosseguindo sem patch.', 'warn');
            doMount(mountData, btn);
            return;
        }

        log('prproj: placeholders encontrados como texto legível — aplicando patch!', 'ok');

        // Diagnóstico: varre todos os blobs PFPD e mostra em qual encoding o placeholder aparece.
        diagnosePFPDBlobs(xml, '[[PRODUCT_PRICE_MIN]]', log);

        // Diagnóstico: escreve o início do XML (~1500 chars) para ver o Project ObjectUID.
        (function() {
            var fsD = tryNodeRequire('fs');
            var osD = tryNodeRequire('os');
            if (!fsD) return;
            var td   = (osD && osD.tmpdir && osD.tmpdir()) || 'C:\\Temp';
            var head = xml.substring(0, 1500);
            try { fsD.writeFileSync(td + '\\ppro_head.xml', head, 'utf8'); }
            catch(eD) { log('[DIAG] Falha ao escrever ppro_head: ' + eD.message, 'warn'); }
        })();

        // 3. Obtém os sequenceIDs reais das templates (Sequence.sequenceID ≠ MasterClip ObjectUID).
        //    Esses IDs são o que o Premiere usa para detectar duplicatas ao importar.
        //    Devemos substituí-los no temp prproj para que o Premiere aceite as sequências como novas.
        var patchedProducts = JSON.parse(JSON.stringify(
            mountData.products || [mountData.product]
        ));

        // ── NOVO: Extrai blobs EG completos (348 bytes) com texto patchado por produto ──
        // Esses blobs preservam a estrutura TextDocument completa (fonte, cor, estilo)
        // e serão usados no setValue do ExtendScript em vez de uma string curta — que
        // destruiria o estilo. Os blobs ficam armazenados em product._egBlobs e fluem
        // automaticamente até mountFromJSON via JSON serialization.
        patchedProducts.forEach(function(prod, pIdx) {
            var blobs = extractPatchedEGBlobsForProduct(xml, prod);
            prod._egBlobs = blobs;
            var blobInfo = [];
            for (var k in blobs) if (blobs.hasOwnProperty(k)) {
                blobInfo.push(k + ' (' + blobs[k].length + 'b base64 ≈ ' + Math.round(blobs[k].length*0.75) + 'b bin)');
            }
            if (blobInfo.length > 0) {
                log('Produto ' + (pIdx+1) + ' EG blobs: ' + blobInfo.join(', '), 'info');
            } else {
                log('Produto ' + (pIdx+1) + ' EG blobs: NENHUM extraído (placeholders fora de blobs base64)', 'warn');
            }
        });

        // Coleta nomes únicos de templates em todos os produtos
        // (ignora LOWERTHIRD/lower_thirds — eles usam o caminho runtime; cada instância tem texto único)
        var allTemplateNames = {};
        patchedProducts.forEach(function(prod) {
            (prod.timeline || []).forEach(function(item) {
                if (item.type === 'template_insert' && item.template && item._ltIndex === undefined) {
                    allTemplateNames['[TEMPLATE] ' + item.template] = true;
                    allTemplateNames['[TEMPLATE]'  + item.template] = true;
                }
            });
        });
        var templateNamesList = Object.keys(allTemplateNames);
        var templateNamesJSON = JSON.stringify(templateNamesList);

        cs.evalScript('getTemplateSequenceIDs(' + JSON.stringify(templateNamesJSON) + ')', function(seqIDsRaw) {
            var templateSeqIDs = {};
            try {
                var parsed = JSON.parse(seqIDsRaw);
                if (parsed && parsed.ids) templateSeqIDs = parsed.ids;
                log('sequenceIDs obtidos: ' + JSON.stringify(templateSeqIDs), 'info');
            } catch(e) {
                log('getTemplateSequenceIDs err: ' + e.message, 'warn');
            }

        // 4. Para cada produto, cria um temp prproj com o texto substituído e GUIDs novos,
        //    importa no Premiere, e anota os nomes das sequências importadas.
        var pendingPatches = 0;
        var patchResults   = []; // { pIdx, error, sequences[] }

        patchedProducts.forEach(function(prod, pIdx) {
            // Só patcheia se o produto tem templates "normais" (PRODUTO/PRECO) — exclui LOWERTHIRD.
            var hasTemplate = (prod.timeline || []).some(function(item) {
                return item.type === 'template_insert' && item._ltIndex === undefined;
            });
            if (!hasTemplate) return;

            pendingPatches++;

            // Calcula os renames de template: [TEMPLATE]PRECO → [PRECO] WAP_Serra...
            // para que cada produto importe uma sequência com nome único e sem conflito.
            // LOWERTHIRD é excluído — clona em runtime via fallback path.
            var renames = [];
            (prod.timeline || []).forEach(function(item) {
                if (item.type === 'template_insert' && item.template && item._ltIndex === undefined) {
                    var cn = computeCopyName(item.template, prod);
                    renames.push({ from: '[TEMPLATE] ' + item.template, to: cn });
                    renames.push({ from: '[TEMPLATE]'  + item.template, to: cn });
                }
            });

            var res = patchPrprojForProduct(prprojPath, prod, 'p' + pIdx, renames, templateSeqIDs);
            if (res.error) {
                log('Produto ' + (pIdx+1) + ' patch err: ' + res.error, 'warn');
                patchResults.push({ pIdx: pIdx, error: res.error });
                pendingPatches--;
                if (pendingPatches === 0) finalizePatch(patchedProducts, mountData, btn, patchResults);
                return;
            }
            log('Produto ' + (pIdx+1) + ': ' + res.found.join(', '), 'ok');

            var escaped = res.tempPath.replace(/\\/g, '\\\\');
            cs.evalScript('importPrproj("' + escaped + '")', function(importRaw) {
                var importRes = {};
                try { importRes = JSON.parse(importRaw); } catch(e) {}
                if (importRes.error) {
                    log('importPrproj err: ' + importRes.error, 'warn');
                } else {
                    log('Sequências importadas: [' + (importRes.sequences || []).join(', ') + ']'
                        + ' | antes=' + importRes.beforeCount + ' depois=' + importRes.afterCount, 'ok');
                    if (importRes.beforeCount === importRes.afterCount) {
                        // Nenhuma sequência nova apareceu — lista IDs para comparar com ObjectUID
                        log('  [DIAG] beforeIDs: ' + (importRes.beforeIDs || ''), 'info');
                        log('  [DIAG] afterIDs:  ' + (importRes.afterIDs  || ''), 'info');
                    }
                    patchResults.push({ pIdx: pIdx, sequences: importRes.sequences || [] });
                }
                // Limpa temp
                try { tryNodeRequire('fs').unlinkSync(res.tempPath); } catch(e) {}
                pendingPatches--;
                if (pendingPatches === 0) finalizePatch(patchedProducts, mountData, btn, patchResults);
            });
        });

        if (pendingPatches === 0) {
            // Nenhum produto tinha template_insert
            doMount(mountData, btn);
        }

        }); // fim cs.evalScript getTemplateSequenceIDs
    });
}

function finalizePatch(patchedProducts, mountData, btn, patchResults) {
    // CRÍTICO: usa patchedProducts (que contém _egBlobs com TextDocument completo de 348b)
    // em vez de mountData.products (sem blobs). Isso faz os blobs fluírem para ExtendScript
    // via JSON, onde setClipText os usa na branch B (preservando estilo do TextDocument).
    var enhancedMountData = {};
    for (var k in mountData) if (mountData.hasOwnProperty(k)) enhancedMountData[k] = mountData[k];
    if (mountData.products) {
        enhancedMountData.products = patchedProducts;
    } else if (mountData.product && patchedProducts.length > 0) {
        enhancedMountData.product = patchedProducts[0];
    }
    log('finalizePatch: encaminhando ' + patchedProducts.length + ' produto(s) com _egBlobs para ExtendScript', 'info');
    doMount(enhancedMountData, btn);
}

// ─── NOVA ESTRATÉGIA: Patch + Reload + Clone (iterativo) ──────────────────────
// O importFiles não funciona com prproj (no-op no PPro 2025). Esta estratégia:
// 1. Identifica UMA vez os ArbVideoComponentParam ObjectIDs que contêm placeholders
//    no template (e captura seus blobs ORIGINAIS — TextDocument de 348 bytes intacto)
// 2. Para cada produto:
//    a. Patcha NO LUGAR (sobrescreve prproj) — usando os ObjectIDs específicos
//       para evitar tocar nos clones já criados; substitui a partir do blob ORIGINAL
//       (não do patchado anterior) para sempre saber o que buscar
//    b. Fecha + reabre o projeto → Premiere carrega TextDocument completo do disco
//    c. Clona o template (clone() preserva o TextDocument estilizado já em memória)
//    d. Renomeia clone para [PRECO] WAP_Serra... e salva
// 3. No final: restaura os blobs ORIGINAIS nos templates e roda mountFromJSON normal
//    — fast path encontra os clones pelo nome e usa-os diretamente
function mountWithReloadStrategy(mountData, btn) {
    cs.evalScript('saveProjectAndGetPath()', function(raw) {
        var prprojPath = '';
        try { prprojPath = JSON.parse(raw).path || ''; } catch(e) {}
        if (!prprojPath) {
            log('Projeto não salvo em disco — reload strategy indisponível. Prosseguindo sem patch.', 'warn');
            doMount(mountData, btn);
            return;
        }

        var firstRead = readPrprojXML(prprojPath);
        if (firstRead.error) {
            log('prproj: ' + firstRead.error + ' — prosseguindo sem patch.', 'warn');
            doMount(mountData, btn);
            return;
        }

        // Identifica blobs com placeholders e captura seus blobs originais
        var blobInfos = findPlaceholderBlobs(firstRead.xml);
        if (blobInfos.length === 0) {
            log('prproj: nenhum blob com placeholder encontrado — prosseguindo sem reload.', 'warn');
            doMount(mountData, btn);
            return;
        }
        log('Reload strategy: ' + blobInfos.length + ' blob(s) EG identificado(s):', 'ok');
        blobInfos.forEach(function(b) {
            log('  ObjectID=' + b.objectID + ' placeholder=' + b.placeholder + ' blobOrig=' + b.originalBin.length + 'b', 'info');
        });

        var products = mountData.products || [mountData.product];
        log('Reload strategy: ' + products.length + ' produto(s) — patch+reload+clone iterativo', 'ok');

        var pIdx = 0;
        function processNext() {
            if (pIdx >= products.length) {
                // Todos os produtos processados — restaura templates e roda mount normal
                log('Reload strategy: restaurando blobs originais dos templates...', 'ok');
                var restoreRes = restoreTemplateBlobs(prprojPath, blobInfos);
                if (restoreRes.error) {
                    log('restore err: ' + restoreRes.error + ' — prosseguindo mesmo assim', 'warn');
                }
                // Reabre projeto uma última vez com templates restaurados
                var escPath = prprojPath.replace(/\\/g, '\\\\');
                cs.evalScript('closeAndReopenProject("' + escPath + '")', function(finalRaw) {
                    var fr = {};
                    try { fr = JSON.parse(finalRaw); } catch(e) {}
                    log('Reload strategy: reopen final ok (seqs=' + (fr.seqCount || '?') + '). Rodando mount.', 'ok');
                    doMount(mountData, btn);
                });
                return;
            }
            var prod  = products[pIdx];
            var label = 'p' + (pIdx + 1);

            // Coleta os templates únicos usados por este produto
            var templates = [];
            var seen = {};
            (prod.timeline || []).forEach(function(item) {
                if (item.type === 'template_insert' && item.template && !seen[item.template]) {
                    seen[item.template] = true;
                    templates.push({
                        name: item.template,
                        copyName: computeCopyName(item.template, prod)
                    });
                }
            });
            if (templates.length === 0) {
                pIdx++;
                processNext();
                return;
            }

            // Patcha SOMENTE os blobs identificados, substituindo o ORIGINAL pelo texto novo
            var patchRes = patchTemplateBlobsForProduct(prprojPath, prod, blobInfos);
            if (patchRes.error) {
                log(label + ' patch err: ' + patchRes.error + ' — pulando produto', 'warn');
                pIdx++;
                processNext();
                return;
            }
            log(label + ' patch: ' + patchRes.changes.join(', '), 'ok');

            // Fecha + reabre o projeto
            var escapedPath = prprojPath.replace(/\\/g, '\\\\');
            cs.evalScript('closeAndReopenProject("' + escapedPath + '")', function(rrRaw) {
                var rr = {};
                try { rr = JSON.parse(rrRaw); } catch(e) {}
                if (rr.error) {
                    log(label + ' reopen err: ' + rr.error + ' — abortando reload strategy', 'error');
                    doMount(mountData, btn);
                    return;
                }
                log(label + ' reopen ok: ' + rr.seqCount + ' sequências carregadas', 'ok');

                // Clona cada template para este produto
                var tIdx = 0;
                function cloneNextTemplate() {
                    if (tIdx >= templates.length) {
                        pIdx++;
                        processNext();
                        return;
                    }
                    var t = templates[tIdx++];
                    var args = JSON.stringify(t.name) + ', ' + JSON.stringify(t.copyName);
                    cs.evalScript('cloneTemplateForProduct(' + args + ')', function(cloneRaw) {
                        var cr = {};
                        try { cr = JSON.parse(cloneRaw); } catch(e) {}
                        if (cr.error) {
                            log(label + ' clone "' + t.name + '" err: ' + cr.error, 'warn');
                        } else {
                            log(label + ' clone: [' + t.name + '] → "' + t.copyName + '"' + (cr.existed ? ' (já existia)' : ''), 'ok');
                        }
                        cloneNextTemplate();
                    });
                }
                cloneNextTemplate();
            });
        }

        processNext();
    });
}

// Identifica todos os ArbVideoComponentParam que contêm placeholders [[PRODUCT_*]]
// no blob base64 (TextDocument de 348 bytes). Retorna array com:
//   { objectID, placeholder, originalBin (binary string da blob inteira),
//     originalB64 (base64 string da blob inteira) }
// Estes ObjectIDs serão usados como ESCOPO para patches subsequentes — assim os
// clones (que têm ObjectIDs novos) não são afetados pelas modificações.
function findPlaceholderBlobs(xml) {
    var result = [];
    var phList = ['[[PRODUCT_PRICE_MIN]]', '[[PRODUCT_PRICE_MAX]]', '[[PRODUCT_PRICE]]',
                  '[[PRODUCT_NAME]]', '[[PRODUCT_BRAND]]'];

    var re = /<ArbVideoComponentParam\s+ObjectID="(\d+)"[^>]*>([\s\S]*?)<\/ArbVideoComponentParam>/g;
    var m;
    while ((m = re.exec(xml)) !== null) {
        var objId   = m[1];
        var content = m[2];
        var bm = content.match(/<StartKeyframeValue\s+Encoding="base64"[^>]*>([\s\S]*?)<\/StartKeyframeValue>/);
        if (!bm) continue;
        var b64 = bm[1].replace(/\s/g, '');
        if (b64.length < 8) continue;
        try {
            var decoded = Buffer.from(b64, 'base64').toString('binary');
            for (var pi = 0; pi < phList.length; pi++) {
                if (decoded.indexOf(phList[pi]) >= 0) {
                    result.push({
                        objectID:   objId,
                        placeholder: phList[pi],
                        originalBin: decoded,
                        originalB64: b64
                    });
                    break; // assume um placeholder por blob
                }
            }
        } catch(eB) { /* ignora */ }
    }
    return result;
}

// Patcha os blobs dos templates COM ESCOPO POR OBJECTID:
// Para cada blobInfo (identificado por ObjectID), substitui o blob original
// por uma cópia com o placeholder trocado pelo texto novo (null-padded).
// IMPORTANTE: Sempre parte do blob ORIGINAL (blobInfo.originalBin), não do que
// está atualmente no XML — isso permite chamar essa função iterativamente sem
// se preocupar com "currentText" tracking. Clones não são tocados (ObjectIDs novos).
function patchTemplateBlobsForProduct(prprojPath, product, blobInfos) {
    var read = readPrprojXML(prprojPath);
    if (read.error) return { error: read.error };

    function priceNum(val) {
        return formatPriceByLang(val, loadedJSON && loadedJSON.language);
    }
    function padNullTo(str, targetLen) {
        var r = str.length > targetLen ? str.substring(0, targetLen) : str;
        while (r.length < targetLen) r += '\x00';
        return r;
    }

    var phValues = {
        '[[PRODUCT_PRICE_MIN]]': priceNum(product.price_min || product.price),
        '[[PRODUCT_PRICE_MAX]]': priceNum(product.price_max || product.price),
        '[[PRODUCT_PRICE]]':     priceNum(product.price),
        '[[PRODUCT_NAME]]':      product.name  || '',
        '[[PRODUCT_BRAND]]':     product.brand || ''
    };

    var xml = read.xml;
    var changes = [];

    blobInfos.forEach(function(info) {
        var newText = phValues[info.placeholder];
        if (!newText) return;
        // Patcha o BLOB ORIGINAL com o texto novo (null-padded)
        var origBin = info.originalBin;
        var idx = origBin.indexOf(info.placeholder);
        if (idx < 0) return; // não deveria acontecer
        var paddedNew = padNullTo(newText, info.placeholder.length);
        var newBin = origBin.substring(0, idx) + paddedNew + origBin.substring(idx + info.placeholder.length);
        var newB64 = Buffer.from(newBin, 'binary').toString('base64');

        // Substitui SOMENTE dentro do <ArbVideoComponentParam ObjectID="N">
        // (não afeta outras blobs com ObjectIDs diferentes — como os clones)
        var elemRe = new RegExp(
            '(<ArbVideoComponentParam\\s+ObjectID="' + info.objectID + '"[^>]*>[\\s\\S]*?<StartKeyframeValue\\s+Encoding="base64"[^>]*>)' +
            '([\\s\\S]*?)' +
            '(<\\/StartKeyframeValue>)'
        );
        var matched = false;
        xml = xml.replace(elemRe, function(_full, pre, _b64old, post) {
            matched = true;
            return pre + newB64 + post;
        });
        if (matched) changes.push('OID=' + info.objectID + ' ' + info.placeholder + '→' + newText);
    });

    if (changes.length === 0) {
        return { error: 'nenhum blob alvo encontrado no XML' };
    }

    var writeRes = writePrprojXML(prprojPath, xml);
    if (writeRes.error) return { error: 'write: ' + writeRes.error };
    return { changes: changes };
}

// Restaura os blobs ORIGINAIS (com placeholders) nos templates.
// Chamado no final do reload strategy para deixar os templates como antes da execução.
// Os clones já criados não são afetados (têm ObjectIDs diferentes).
function restoreTemplateBlobs(prprojPath, blobInfos) {
    var read = readPrprojXML(prprojPath);
    if (read.error) return { error: read.error };
    var xml = read.xml;
    var restored = 0;

    blobInfos.forEach(function(info) {
        var elemRe = new RegExp(
            '(<ArbVideoComponentParam\\s+ObjectID="' + info.objectID + '"[^>]*>[\\s\\S]*?<StartKeyframeValue\\s+Encoding="base64"[^>]*>)' +
            '([\\s\\S]*?)' +
            '(<\\/StartKeyframeValue>)'
        );
        var matched = false;
        xml = xml.replace(elemRe, function(_full, pre, _b64old, post) {
            matched = true;
            return pre + info.originalB64 + post;
        });
        if (matched) restored++;
    });

    var writeRes = writePrprojXML(prprojPath, xml);
    if (writeRes.error) return { error: 'write: ' + writeRes.error };
    return { restored: restored };
}

function mountVideo() {
    if (!loadedJSON) return;

    // Detecta formato multi-produto ou legado
    var isMulti  = !!(loadedJSON.products && loadedJSON.products.length);
    var products = isMulti
        ? loadedJSON.products
        : [Object.assign({}, loadedJSON.product || {}, { timeline: loadedJSON.timeline || [] })];

    // Verifica necessidade de transcrição (ignora stock_video que serão descartados)
    var needsTranscript = false;
    products.forEach(function (prod) {
        (prod.timeline || []).forEach(function (item) {
            if (item.type !== "stock_video" && item.after_phrase && item.time_seconds === undefined) needsTranscript = true;
        });
    });

    var hasTranscript = transcriptWords.length > 0 || srtEntries.length > 0;
    if (needsTranscript && !hasTranscript) {
        log("Este JSON usa after_phrase mas nenhuma transcrição foi carregada. Carregue o JSON do Premiere (Text > ··· > Export transcript (json)).", "error");
        return;
    }

    var transcriptMode = transcriptWords.length > 0 ? "JSON Premiere (palavra)" : "SRT";
    if (needsTranscript) log("Resolvendo timestamps via " + transcriptMode + "...", "info");

    var totalSkipped = 0;

    // Cursor de tempo: cada busca de frase só considera ocorrências DEPOIS desse tempo.
    // Avança conforme processamos itens em ordem cronológica. Isso evita que frases
    // duplicadas entre produtos (ex: "base é de aço estampado") sejam matchadas no
    // produto errado — cada produto começa a busca onde o produto anterior terminou.
    var phraseCursor = 0;

    var mountProducts = products.map(function (prod, pIdx) {
        var productCopy = JSON.parse(JSON.stringify(prod));

        // image_transparent (foto do produto nos cards) vem da referência "png" do
        // bin PROD_N — definida depois, no callback de getProductBinMedia.

        // cursor_reset: true → reinicia o cursor de busca pro início do vídeo.
        // Necessário no modo head-to-head quando as frases de um produto aparecem
        // intercaladas com as do anterior (ex: p2 tem frases em 24s mas o cursor
        // chegou a 263s depois do PRECO do p1).
        if (prod.cursor_reset) {
            phraseCursor = parseFloat(prod.cursor_reset) > 0
                ? parseFloat(prod.cursor_reset) : 0;
        }

        // ── Snapshot do cursor no INÍCIO do produto ─────────────────────────
        // Usado por lower_thirds num pass separado pra não disputarem cursor com
        // PRODUTO/PRECO (cujos times naturalmente atravessam o trecho onde os
        // lower thirds aparecem). Sem isso, o cursor avança até PRECO e os
        // lower_thirds ficariam sempre não-encontrados.
        var productStartCursor = phraseCursor;

        productCopy.timeline = (prod.timeline || []).filter(function (item) {
            return item.type !== "stock_video";
        }).map(function (item, idx) {
            var copy  = JSON.parse(JSON.stringify(item));
            var label = "[p" + (pIdx + 1) + " item " + (idx + 1) + " / " + copy.type + "]";

            if (copy.after_phrase && copy.time_seconds === undefined) {
                var t = findPhraseTime(copy.after_phrase, phraseCursor);
                if (t !== null) {
                    copy.time_seconds = t;
                    phraseCursor = t; // próxima busca a partir desse ponto
                } else {
                    copy._unresolved = true;
                    totalSkipped++;
                    log(label + ' Frase não encontrada (após t=' + phraseCursor.toFixed(2) + 's): "' + copy.after_phrase + '" — item ignorado.', "warn");
                }
            }

            if (copy.file) {
                copy.file = resolvePath(copy.file);
                // Pré-computa dimensões pra Scale to Frame Size confiável
                if (copy.type === "product_image" || copy.type === "stock_image") {
                    var d = getImageDimensions(copy.file);
                    if (d) { copy.src_w = d.w; copy.src_h = d.h; }
                }
            }

            return copy;
        });

        // ── Pass separado pra lower_thirds com cursor próprio ────────────────
        // Cursor começa no início do produto (productStartCursor) e avança
        // localmente. Cada lower_third aparece como um template_insert com
        // text_overrides {INFO, SUB-INFO} e _ltIndex pra naming único.
        if (prod.lower_thirds && prod.lower_thirds.length > 0) {
            var ltCursor = productStartCursor;
            prod.lower_thirds.forEach(function(lt, ltIdx) {
                if (!lt.after_phrase) return;
                var label = "[p" + (pIdx + 1) + " lower_third " + (ltIdx + 1) + "]";
                var ltItem = {
                    type:           "template_insert",
                    template:       lt.template || "LOWERTHIRD",
                    after_phrase:   lt.after_phrase,
                    track:          lt.track    !== undefined ? lt.track    : 3,
                    duration:       lt.duration !== undefined ? lt.duration : 4,
                    text_overrides: {
                        "INFO":     lt.info     || "",
                        "SUB-INFO": lt.sub_info || ""
                    },
                    _ltIndex: ltIdx + 1
                };
                var t = findPhraseTime(lt.after_phrase, ltCursor);
                if (t !== null) {
                    ltItem.time_seconds = t;
                    ltCursor = t;
                    productCopy.timeline.push(ltItem);
                } else {
                    totalSkipped++;
                    log(label + ' Frase não encontrada (após t=' + ltCursor.toFixed(2) + 's): "' + lt.after_phrase + '" — lower third ignorado.', "warn");
                }
            });
            // Avança o cursor global para o máximo entre cursor atual e cursor de lower thirds
            // (caso lower thirds tenham passado do PRECO, o que é incomum mas possível).
            if (ltCursor > phraseCursor) phraseCursor = ltCursor;
        }

        return productCopy;
    });

    if (totalSkipped > 0) {
        log(totalSkipped + " item(s) não encontrado(s) na transcrição. Verifique se as frases estão exatamente como foram ditas.", "warn");
    }

    // ── Aplica preferências de "expand" da aba Templates ──────────────────
    // Cada template_insert ganha _expand=true se o usuário marcou o checkbox
    // pra esse template na aba Templates (persistido em localStorage).
    var expandPrefs   = getAllExpandPrefs();
    var expandedNames = {};
    mountProducts.forEach(function(prod) {
        (prod.timeline || []).forEach(function(item) {
            if (item.type === "template_insert" && item.template) {
                if (expandPrefs[item.template]) {
                    item._expand = true;
                    expandedNames[item.template] = true;
                }
            }
        });
    });
    var expandedList = Object.keys(expandedNames);
    if (expandedList.length > 0) {
        log("Modo expand ativo pra: " + expandedList.join(", "), "info");
    }

    var mountData = isMulti
        ? { products: mountProducts }
        : { product: mountProducts[0], timeline: mountProducts[0].timeline };

    var btn = document.getElementById("btn-mount");
    btn.disabled    = true;
    btn.textContent = "Montando...";

    var totalItems = mountProducts.reduce(function (acc, p) { return acc + (p.timeline || []).length; }, 0);
    log("Iniciando montagem: " + products.length + " produto(s), " + totalItems + " item(s)...", "info");

    // Fonte de mídia agora é sempre o bin PROD_N — sempre passa pelo preparo
    // (busca bin media + durações de template) antes de montar.
    applyAutoFillThenMount(mountProducts, mountData, isMulti, btn);
}

// Modo IA: query duração dos templates → gera slots auto-fill entre PRODUTO e PRECO
function applyAutoFillThenMount(mountProducts, mountData, isMulti, btn) {
    // Coleta nomes únicos dos templates usados
    var templateNames = {};
    mountProducts.forEach(function(p) {
        (p.timeline || []).forEach(function(item) {
            if (item.type === "template_insert" && item.template) {
                templateNames[item.template] = true;
            }
        });
    });
    // Inclui os MOGRTs dos pontos-chave (ex: LIKE) pra medir a duração deles.
    if (loadedJSON.key_points && loadedJSON.key_points.length) {
        loadedJSON.key_points.forEach(function (kp) {
            if (kp.mogrt) templateNames[kp.mogrt] = true;
        });
    }
    var nameList = Object.keys(templateNames);

    if (nameList.length === 0) {
        log("Modo IA: nenhum template encontrado na timeline.", "warn");
        doMount(mountData, btn);
        return;
    }

    var namesJSON = JSON.stringify(JSON.stringify(nameList));

    // Query vídeos de produto (PROD_N) na bin ANTES de montar o auto-fill.
    // Inclui também as pastas do global_fill (head-to-head) se existirem.
    var __folders = [];
    mountProducts.forEach(function (p) { if (p.folder != null) __folders.push(String(p.folder)); });
    if (loadedJSON.global_fill) {
        var __pushF = function (f) {
            var fs = String(f);
            if (__folders.indexOf(fs) < 0) __folders.push(fs);
        };
        if (loadedJSON.global_fill.folders) loadedJSON.global_fill.folders.forEach(__pushF);
        // pastas referenciadas nos segmentos (modo head-to-head sincronizado)
        if (loadedJSON.global_fill.segments) {
            loadedJSON.global_fill.segments.forEach(function (s) {
                (s.folders || []).forEach(__pushF);
            });
        }
    }
    cs.evalScript("getProductBinMedia(" + JSON.stringify(JSON.stringify(__folders)) + ")", function (rawV) {
      var binMedia = {};
      try { binMedia = JSON.parse(rawV) || {}; } catch (eV) {}
      // Log + define a imagem do card (image_transparent) a partir da referência png do bin.
      var __bk = [];
      mountProducts.forEach(function (p) {
        var bm = binMedia[String(p.folder)];
        if (!bm) { __bk.push("PROD_" + p.folder + ": (bin vazio/ausente)"); return; }
        __bk.push("PROD_" + p.folder + ": " + bm.videos.length + " vídeo / " + bm.images.length + " img / " + (bm.ref ? "ref ✓" : "SEM ref png"));
        if (bm.ref) {
          p.image_transparent = bm.ref;
          var dd = getImageDimensions(bm.ref);
          if (dd) { p.image_transparent_w = dd.w; p.image_transparent_h = dd.h; }
        }
      });
      if (__bk.length) log("Bins de produto: " + __bk.join(" | "), "ok");

    cs.evalScript("getTemplateDurations(" + namesJSON + ")", function(raw) {
        var durations = {}, methods = {}, contentDurations = {};
        try {
            var parsed = JSON.parse(raw);
            durations = parsed.durations || {};
            methods = parsed.methods || {};
            contentDurations = parsed.contentDurations || {};
        } catch(e) {}
        log("Modo IA: durações dos templates: " + JSON.stringify(durations) +
            " (métodos: " + JSON.stringify(methods) + ")", "info");

        var slotDurEl = document.getElementById("ia-slot-duration");
        var slotDur = parseFloat((slotDurEl && slotDurEl.value) || "5") || 5;

        var root = getRootFolder();
        var totalAutoFill = 0;

        // Head-to-head: quando há global_fill, ele é o ÚNICO preenchedor da faixa
        // de comparação. O auto-fill por produto é suprimido pra não colidir
        // (senão p1 e p2 enchem quase o vídeo todo sobrepostos com o global_fill).
        var globalFillActive = !!(loadedJSON.global_fill &&
            ((loadedJSON.global_fill.folders && loadedJSON.global_fill.folders.length) ||
             (loadedJSON.global_fill.segments && loadedJSON.global_fill.segments.length)));

        mountProducts.forEach(function(prod, pIdx) {
            var bm = binMedia[String(prod.folder)] || { videos: [], images: [], videoTotal: 0, ref: null };
            if (bm.videos.length === 0 && bm.images.length === 0) {
                log("p" + (pIdx+1) + ": bin PROD_" + prod.folder + " sem vídeos/imagens — auto-fill pulado.", "warn");
                return;
            }

            // Limpa qualquer mídia antiga da timeline (modelo é 100% por bin agora)
            prod.timeline = (prod.timeline || []).filter(function(it) {
                return it.type !== "product_image" && it.type !== "product_video";
            });

            // Head-to-head: pula o preenchimento por produto (global_fill cobre).
            if (globalFillActive) {
                if (pIdx === 0) log("Auto-fill por produto SUPRIMIDO (global_fill ativo cobre a faixa).", "info");
                return;
            }

            // Encontra PRODUTO e PRECO
            var produtoItem = null, precoItem = null;
            prod.timeline.forEach(function(item) {
                if (item.type !== "template_insert" || item.time_seconds === undefined) return;
                if (item.template && item.template.toUpperCase().indexOf("PRODUTO") >= 0 && !produtoItem) produtoItem = item;
                if (item.template && item.template.toUpperCase().indexOf("PRECO") >= 0) precoItem = item;
            });
            if (!produtoItem) {
                log("p" + (pIdx+1) + ": auto-fill ignorado (PRODUTO não encontrado/resolvido — sem ponto de início)", "warn");
                return;
            }

            var produtoDur = durations[produtoItem.template] || 5;
            var fillStart  = produtoItem.time_seconds + produtoDur;
            var fillEnd;

            if (precoItem) {
                // Caso normal: tem PRECO → preenche até ele.
                fillEnd = precoItem.time_seconds;
            } else {
                // PRECO faltando: estende até o INÍCIO do próximo produto.
                // Pra o último produto sem PRECO: usa só os vídeos na duração
                // natural (sem loop) — assume duração razoável.
                var nextProdStart = null;
                for (var npI = pIdx + 1; npI < mountProducts.length; npI++) {
                    var npProd = mountProducts[npI];
                    if (!npProd || !npProd.timeline) continue;
                    for (var npJ = 0; npJ < npProd.timeline.length; npJ++) {
                        var npIt = npProd.timeline[npJ];
                        if (npIt.type === "template_insert" && npIt.template &&
                            npIt.template.toUpperCase().indexOf("PRODUTO") >= 0 &&
                            npIt.time_seconds !== undefined) {
                            nextProdStart = npIt.time_seconds + (npIt.offset_seconds || 0);
                            break;
                        }
                    }
                    if (nextProdStart !== null) break;
                }
                if (nextProdStart !== null) {
                    fillEnd = nextProdStart;
                    log("p" + (pIdx+1) + ": PRECO não resolvido — fallback: preenchendo até o próximo produto (" + fillEnd.toFixed(1) + "s)", "warn");
                } else {
                    // Último produto sem PRECO: usa duração natural dos vídeos como aproximação.
                    var natDur = (bm.videoTotal || 0) || 30; // fallback 30s se não tiver vídeo
                    fillEnd = fillStart + natDur;
                    log("p" + (pIdx+1) + ": PRECO não resolvido e é o último produto — usando duração natural dos vídeos (" + natDur.toFixed(1) + "s)", "warn");
                }
            }

            var fillDur = fillEnd - fillStart;
            if (fillDur < 1) {
                log("p" + (pIdx+1) + ": auto-fill pulado (gap muito pequeno: " + fillDur.toFixed(2) + "s)", "warn");
                return;
            }

            var track = produtoItem.track || 1;
            var addedItems = [];

            // ── VÍDEOS DO BIN: entram PRIMEIRO, na duração natural (cortado no preço).
            var imgStart = fillStart;
            var videoLooped = 0;
            // Expande cada vídeo do bin nas suas JANELAS (regiões marcadas, ou in/out,
            // ou vídeo inteiro). Cada janela vira um clipe — regiões = vários trechos.
            var vwins = bm.videos.length ? bm.videos.reduce(function (acc, v) { return acc.concat(_videoWindows(v)); }, []) : [];
            if (vwins.length) {
                var vcursor = fillStart, nVid = 0;
                for (var vi = 0; vi < vwins.length; vi++) {
                    if (vcursor >= fillEnd - 0.2) break;
                    var vwf = vwins[vi];
                    var vdurFull = vwf.winLen || 0;
                    if (!(vdurFull > 0)) continue;
                    var vdur = Math.min(vdurFull, fillEnd - vcursor); // corta o último se passar
                    addedItems.push({
                        type: "product_video", bin_name: vwf.name,
                        bin_path: vwf.path || null,
                        time_seconds: vcursor, duration: vdur, track: track, _autofill: true,
                        win_start: vwf.winStart, win_len: vdurFull
                    });
                    vcursor += vdurFull; nVid++;
                }

                // SE NÃO HOUVER IMAGENS no bin e ainda sobrar gap, faz LOOP das janelas
                // (cicla na lista repetindo o(s) mesmo(s) trecho(s) — análogo ao loop
                // de imagens em slots cíclicos).
                if (bm.images.length === 0 && vcursor < fillEnd - 0.2) {
                    var loopIdx = vwins.length;
                    var safety  = vwins.length * 50;
                    while (vcursor < fillEnd - 0.2 && safety-- > 0) {
                        var lv = vwins[loopIdx % vwins.length];
                        var lvdur = lv.winLen || 0;
                        if (!(lvdur > 0)) { loopIdx++; continue; }
                        var thisDur = Math.min(lvdur, fillEnd - vcursor);
                        addedItems.push({
                            type: "product_video", bin_name: lv.name,
                            bin_path: lv.path || null,
                            time_seconds: vcursor, duration: thisDur, track: track, _autofill: true,
                            win_start: lv.winStart, win_len: lvdur
                        });
                        vcursor += lvdur; loopIdx++; videoLooped++;
                    }
                }

                imgStart = Math.min(vcursor, fillEnd);
                if (videoLooped > 0) {
                    log("p" + (pIdx+1) + ": " + nVid + " vídeo(s) + " + videoLooped + " repetição(ões) em loop (sem imagens no bin) — cobertura até " + fillEnd.toFixed(1) + "s", "info");
                } else {
                    log("p" + (pIdx+1) + ": " + nVid + " vídeo(s) do bin (" + bm.videoTotal.toFixed(1) + "s) — imagens preenchem de " + imgStart.toFixed(1) + "s a " + fillEnd.toFixed(1) + "s", "info");
                }
            }

            // ── IMAGENS DO BIN: em loop, preenchendo o resto até o preço.
            var nImg = bm.images.length;
            var imgFillDur = fillEnd - imgStart;
            var numSlots = (imgFillDur > 0.2 && nImg >= 1) ? Math.ceil(imgFillDur / slotDur) : 0;
            for (var i = 0; i < numSlots; i++) {
                var t0 = imgStart + i * slotDur;
                var t1 = Math.min(t0 + slotDur, fillEnd);
                if (t1 - t0 < 0.2) break;
                var imgEntry = bm.images[i % nImg];
                addedItems.push({
                    type: "product_image", bin_name: imgEntry.name,
                    bin_path: imgEntry.path || null,
                    time_seconds: t0, duration: t1 - t0, animation: "none",
                    track: track, _autofill: true,
                    _zoomPreset: (i % 2 === 0) ? "ZOOMIN" : "ZOOMOUT"
                });
            }
            // Warning final só se NEM vídeo (loop) NEM imagem conseguiu cobrir.
            if (imgFillDur > 0.2 && nImg < 1 && videoLooped === 0) {
                log("p" + (pIdx+1) + ": vídeos terminaram em " + imgStart.toFixed(1) + "s mas o bin não tem nada utilizável pra preencher até " + fillEnd.toFixed(1) + "s.", "warn");
            }

            prod.timeline = prod.timeline.concat(addedItems);
            prod.timeline.sort(function(a, b) { return (a.time_seconds || 0) - (b.time_seconds || 0); });
            totalAutoFill += addedItems.length;
            log("p" + (pIdx+1) + ": auto-fill " + addedItems.length + " item(s) [" + fillStart.toFixed(1) + "s→" + fillEnd.toFixed(1) + "s] (" + bm.videos.length + " vídeo, " + nImg + " img loop)", "ok");
        });

        log("Auto-fill total: " + totalAutoFill + " imagem(ns) inserida(s) na timeline.", "ok");

        // ── PONTOS-CHAVE (calculado ANTES do pós-PRECO, pra o fill respeitar os CTAs)
        var keyPointFits = [];
        var ctaStarts = [];
        if (loadedJSON.key_points && loadedJSON.key_points.length) {
            var kpRes = buildKeyPointItems(loadedJSON.key_points, durations, mountProducts);
            if (kpRes.items.length) {
                var kpProd = mountProducts[mountProducts.length - 1];
                kpProd.timeline = (kpProd.timeline || []).concat(kpRes.items);
                kpProd.timeline.sort(function (a, b) { return (a.time_seconds || 0) - (b.time_seconds || 0); });
                log("Pontos-chave: " + kpRes.items.length + " item(s) inserido(s).", "ok");
            }
            keyPointFits = kpRes.fits || [];
            ctaStarts = kpRes.ctaStarts || [];
        }

        // ── FALLBACK PÓS-PRECO: fecha o que o stretch do PRECO não cobrir ──────
        // O host estica o PRECO até no máximo (precoStart + conteúdo do template).
        // Se ainda sobrar gap até o próximo produto, preenchemos com as imagens
        // do produto — garantindo zero buracos independente da reserva do PRECO.
        // EXCEÇÃO: se um CTA cai nessa janela, o stock do CTA cobre — pulamos o fill.
        var postPrecoFill = 0;
        // Head-to-head: global_fill cobre toda a faixa → não roda o pós-preço
        // por produto (evita sobreposição na cauda da comparação).
        for (var pf = 0; !globalFillActive && pf < mountProducts.length - 1; pf++) {
            var prodA = mountProducts[pf];
            var bmA = binMedia[String(prodA.folder)];
            // Bin totalmente vazio (sem imagens E sem vídeos) → não tem como preencher.
            if (!bmA ||
                ((!bmA.images || bmA.images.length === 0) &&
                 (!bmA.videos || bmA.videos.length === 0))) continue;

            var precoA = null;
            (prodA.timeline || []).forEach(function (it) {
                if (it.type === "template_insert" && it.template &&
                    it.template.toUpperCase().indexOf("PRECO") >= 0 && it.time_seconds !== undefined) precoA = it;
            });
            if (!precoA) continue;

            var nextStartPF = null;
            (mountProducts[pf + 1].timeline || []).forEach(function (it) {
                if (it.type === "template_insert" && it.template &&
                    it.template.toUpperCase().indexOf("PRODUTO") >= 0 && it.time_seconds !== undefined) {
                    var ns = it.time_seconds + (it.offset_seconds || 0);
                    if (nextStartPF === null || ns < nextStartPF) nextStartPF = ns;
                }
            });
            if (nextStartPF === null) continue;

            var precoStartA = precoA.time_seconds + (precoA.offset_seconds || 0);

            // Se um CTA cai entre o PRECO e o próximo produto, o stock do CTA cobre
            // essa janela — então não preenchemos com imagens (evita conflito na track).
            var ctaInGap = false;
            for (var ci = 0; ci < ctaStarts.length; ci++) {
                if (ctaStarts[ci] > precoStartA && ctaStarts[ci] < nextStartPF) { ctaInGap = true; break; }
            }
            if (ctaInGap) continue;

            var contentMax  = contentDurations[precoA.template] || durations[precoA.template] || 5;
            var stretchEnd  = Math.min(nextStartPF, precoStartA + contentMax);
            var gapPF       = nextStartPF - stretchEnd;
            if (gapPF < 0.5) continue; // PRECO cobre o gap todo

            var trackA  = precoA.track || 1;
            var fillItems = [];
            if (bmA.images && bmA.images.length) {
                // Caminho normal: loop de imagens em slots fixos.
                var nImgsA  = bmA.images.length;
                var nSlotsPF = Math.ceil(gapPF / slotDur);
                for (var kf = 0; kf < nSlotsPF; kf++) {
                    var ft0 = stretchEnd + kf * slotDur;
                    var ft1 = Math.min(ft0 + slotDur, nextStartPF);
                    if (ft1 - ft0 < 0.2) break;
                    var imgEntryPF = bmA.images[kf % nImgsA];
                    fillItems.push({
                        type: "product_image", bin_name: imgEntryPF.name,
                        bin_path: imgEntryPF.path || null,
                        time_seconds: ft0, duration: ft1 - ft0, animation: "none",
                        track: trackA, _autofill: true, _postpreco: true,
                        _zoomPreset: (kf % 2 === 0) ? "ZOOMIN" : "ZOOMOUT"
                    });
                }
            } else {
                // Bin só tem vídeos — faz loop das JANELAS (regiões/in-out) pra cobrir o gap.
                var vwinsPF = bmA.videos.reduce(function (acc, v) { return acc.concat(_videoWindows(v)); }, []);
                var vcurPF = stretchEnd;
                var loopIdxPF = 0;
                var safetyPF = (vwinsPF.length || 1) * 50;
                while (vcurPF < nextStartPF - 0.2 && safetyPF-- > 0 && vwinsPF.length) {
                    var pv = vwinsPF[loopIdxPF % vwinsPF.length];
                    var pvdur = pv.winLen || 0;
                    if (!(pvdur > 0)) { loopIdxPF++; continue; }
                    var thisDurPF = Math.min(pvdur, nextStartPF - vcurPF);
                    fillItems.push({
                        type: "product_video", bin_name: pv.name,
                        bin_path: pv.path || null,
                        time_seconds: vcurPF, duration: thisDurPF, track: trackA,
                        _autofill: true, _postpreco: true,
                        win_start: pv.winStart, win_len: pvdur
                    });
                    vcurPF += pvdur; loopIdxPF++;
                }
            }
            if (fillItems.length) {
                prodA.timeline = prodA.timeline.concat(fillItems);
                prodA.timeline.sort(function (a, b) { return (a.time_seconds || 0) - (b.time_seconds || 0); });
                postPrecoFill += fillItems.length;
                log("p" + (pf + 1) + ": pós-PRECO fill " + fillItems.length + " imagem(ns) [" +
                    stretchEnd.toFixed(1) + "s→" + nextStartPF.toFixed(1) + "s]", "info");
            }
        }
        if (postPrecoFill > 0) log("Pós-PRECO: " + postPrecoFill + " imagem(ns) fechando buracos da narração.", "ok");

        // ── RECAP/CONCLUSÃO: visuais dos produtos mencionados no final ─────────
        // Inserido DEPOIS do auto-fill (senão a limpeza de product_image manuais
        // do auto-fill removeria estes itens).
        if (loadedJSON.conclusion && loadedJSON.conclusion.recap && loadedJSON.conclusion.recap.length) {
            var maxT = 0;
            mountProducts.forEach(function (p) {
                (p.timeline || []).forEach(function (it) {
                    // Ignora itens de ponto-chave (ex: CTA do fim ~504s) — senão o cursor
                    // da recap começaria depois das frases da recap (~481-500s).
                    if (it._keypoint) return;
                    if (it.time_seconds && it.time_seconds > maxT) maxT = it.time_seconds;
                });
            });
            var recapItems = buildRecapTimeline(mountProducts, loadedJSON.conclusion, maxT, slotDur, binMedia);
            if (recapItems.length) {
                var lastProd = mountProducts[mountProducts.length - 1];
                lastProd.timeline = (lastProd.timeline || []).concat(recapItems);
                lastProd.timeline.sort(function (a, b) { return (a.time_seconds || 0) - (b.time_seconds || 0); });
                log("Recap: " + recapItems.length + " item(s) inserido(s) no final do vídeo.", "ok");
            }
        }

        // ── GLOBAL FILL: preenchimento head-to-head ────────────────────────────
        // Ativa SOMENTE se o JSON tiver "global_fill". Não afeta o modo padrão.
        // Dois modos:
        //   • SEGMENTOS (gf.segments): cada segmento define [start_phrase → próximo]
        //     e quais pasta(s) mostrar nesse trecho → SINCRONIZA com a narração.
        //     1 pasta = mostra só ela; 2+ pastas = intercala dentro do trecho;
        //     pastas vazias [] = só marca o fim (boundary).
        //   • INTERCALADO (legado, gf.folders): cicla as pastas cego entre
        //     start_phrase e end_phrase.
        // Adicionado como PRODUTO VIRTUAL no fim → processa depois de tudo,
        // sobrescrevendo com overwriteClip sem conflito de _vidEnd.
        log("Global fill: verificando (global_fill " + (loadedJSON.global_fill ? "presente" : "ausente") + ")...", "info");
        if (loadedJSON.global_fill &&
            ((loadedJSON.global_fill.folders && loadedJSON.global_fill.folders.length) ||
             (loadedJSON.global_fill.segments && loadedJSON.global_fill.segments.length))) {
            var gf = loadedJSON.global_fill;
            var gfSlot    = parseFloat(gf.slot_duration || slotDur) || slotDur;
            var gfTrack   = gf.track || 1;
            var gfSegments = (gf.segments && gf.segments.length) ? gf.segments : null;

            // União de TODAS as pastas referenciadas (topo + segmentos).
            var gfFolderMap = {};
            (gf.folders || []).forEach(function (f) { gfFolderMap[String(f)] = true; });
            if (gfSegments) gfSegments.forEach(function (s) {
                (s.folders || []).forEach(function (f) { gfFolderMap[String(f)] = true; });
            });
            var gfFolders = Object.keys(gfFolderMap);

            // Filas circulares por pasta
            var gfQueues = {};
            var gfHasMedia = false;
            gfFolders.forEach(function (folder) {
                var bm = binMedia[folder] || {};
                // Expande cada vídeo nas suas JANELAS (regiões marcadas, ou in/out,
                // ou vídeo inteiro). A fila cicla entre as janelas como clipes.
                var gfWindows = (bm.videos || []).reduce(function (acc, v) { return acc.concat(_videoWindows(v)); }, []);
                gfQueues[folder] = {
                    images: bm.images || [], imgIdx: 0,
                    videos: gfWindows, vidIdx: 0
                };
                if ((bm.images && bm.images.length) || gfWindows.length) gfHasMedia = true;
                log("Global fill pasta " + folder + ": " +
                    (bm.images ? bm.images.length : 0) + " img, " +
                    (bm.videos ? bm.videos.length : 0) + " vid (" + gfWindows.length + " janela(s))", "info");
                // Mostra a janela usável de cada vídeo: regiões marcadas (cada uma vira
                // um trecho) ou o in/out. Sem nada → vídeo inteiro (pode "pegar outras
                // cenas"). O fill anda DENTRO dessas janelas.
                (bm.videos || []).forEach(function (v) {
                    var inP = (v.inP || 0), outP = (v.outP || 0), len = (v.dur || 0);
                    if (v.regions && v.regions.length) {
                        var rdesc = v.regions.map(function (r) { return "[" + r.start.toFixed(1) + "→" + r.end.toFixed(1) + "]"; }).join(" ");
                        log("   • " + v.name + ": " + v.regions.length + " região(ões) marcada(s): " + rdesc + "s", "info");
                    } else {
                        var looksFull = (inP <= 0.04 && len > 45); // começa em 0 e janela longa = provável SEM marcação
                        log("   • " + v.name + ": janela in/out [" + inP.toFixed(1) + "→" + outP.toFixed(1) + "]s (" + len.toFixed(1) + "s usáveis)" +
                            (looksFull ? "  ⚠ parece SEM in/out nem regiões — vai usar o vídeo inteiro" : ""),
                            looksFull ? "warn" : "info");
                    }
                });
            });

            var gfItems = [];
            // Offset dentro de cada vídeo (por nome) — avança a janela a cada
            // reutilização do mesmo clip (variedade visual). Compartilhado entre
            // segmentos pra continuar avançando o tempo do vídeo.
            var gfInOffsets = {};

            // ── REMAP DE TRACKS (head-to-head) ─────────────────────────────────
            // O fill é a BASE (tracks gfTrack e gfTrack+1) e roda CONTÍNUO. Em vez
            // de reservar intervalos (que dependia de adivinhar a duração do card),
            // subimos os cards (PRODUTO/PRECO) e o LIKE pra tracks ACIMA do fill e
            // da lower third → o card sempre aparece por cima, nunca é comido.
            // Prioridade visual: transição(5) > card/mogrt(4) > lower third/stock(3)
            // > fill FIT(2) > fill blur(1). Transições NÃO se movem (ficam no topo,
            // aplicando o efeito em tudo abaixo).
            var HH_CARD_TRACK  = 4; // PRODUTO/PRECO + MOGRT do LIKE
            var HH_STOCK_TRACK = 3; // stock (vídeo) do LIKE — acima do fill, abaixo do mogrt
            var _hhMoved = 0;
            mountProducts.forEach(function (p) {
                (p.timeline || []).forEach(function (it) {
                    if (it._globalfill) return;
                    var tpl = (it.template || "").toUpperCase();
                    if (tpl.indexOf("TRANSICAO") >= 0 || tpl.indexOf("TRANSIÇÃO") >= 0) return; // transições ficam
                    if (it.type === "template_insert" && it._ltIndex === undefined &&
                        (tpl.indexOf("PRODUTO") >= 0 || tpl.indexOf("PRECO") >= 0)) {
                        it.track = HH_CARD_TRACK; _hhMoved++;        // card intro/preço
                    } else if (it._keypoint && it.type === "template_insert") {
                        it.track = HH_CARD_TRACK; _hhMoved++;        // MOGRT do LIKE
                    } else if (it._keypoint) {
                        it.track = HH_STOCK_TRACK; _hhMoved++;       // stock (vídeo) do LIKE
                    }
                });
            });
            log("Global fill: " + _hhMoved + " item(s) realocado(s) acima do fill (cards/LIKE) — fill roda contínuo embaixo.", "info");

            // Fill contínuo: sem intervalos protegidos (o remap de tracks resolve).
            var gfProtected = [];

            // Subtrai os protegidos de [a,b] → lista de sub-intervalos livres.
            // (gfProtected vazio no head-to-head → devolve o span inteiro = contínuo.)
            var gfFreeIntervals = function (a, b) {
                var free = [{ start: a, end: b }];
                for (var pi = 0; pi < gfProtected.length; pi++) {
                    var ps = gfProtected[pi].start, pe = gfProtected[pi].end;
                    var next = [];
                    for (var fi = 0; fi < free.length; fi++) {
                        var fs = free[fi].start, fe = free[fi].end;
                        if (pe <= fs || ps >= fe) { next.push(free[fi]); continue; } // sem overlap
                        if (ps > fs) next.push({ start: fs, end: Math.min(ps, fe) });
                        if (pe < fe) next.push({ start: Math.max(pe, fs), end: fe });
                    }
                    free = next;
                }
                return free;
            };

            // Gera slots num intervalo [spanStart, spanEnd) com a(s) pasta(s) dadas,
            // pulando os trechos protegidos e emendando os slots com leve sobreposição
            // (GFPAD) pra eliminar o gap preto de 1 frame entre clipes.
            var GFPAD = 0.07;
            var gfPushSpan = function (spanStart, spanEnd, folders) {
                if (!folders || !folders.length) return 0;
                if (!(spanEnd > spanStart + 0.2)) return 0;
                var free = gfFreeIntervals(spanStart, spanEnd);
                var idx = 0, added = 0;
                for (var fi = 0; fi < free.length; fi++) {
                    var a = free[fi].start, b = free[fi].end;
                    if (!(b > a + 0.2)) continue;
                    var t = a, safety = 5000;
                    while (t < b - 0.2 && safety-- > 0) {
                        var folder = String(folders[idx % folders.length]);
                        var q = gfQueues[folder];
                        // Anti-sliver: resto pequeno vira um slot só.
                        var rem = b - t;
                        var dur = (rem <= gfSlot * 1.4) ? rem : gfSlot;
                        // Duração colocada na timeline: estende GFPAD pra emendar com o
                        // próximo slot E atravessa a borda do segmento (a próxima
                        // inserção sobrescreve a sobra) — mata o gap de 1 frame tanto
                        // entre slots quanto nas EMENDAS de segmento.
                        if (q && q.videos.length) {
                            var v = q.videos[q.vidIdx % q.videos.length]; q.vidIdx++; // cicla entre as JANELAS (regiões/in-out)
                            var key = v.key;
                            var vdur = v.winLen || 60;
                            // Slot não passa do tamanho da janela (região curta → slot curto).
                            if (vdur < dur) dur = Math.max(0.2, vdur);
                            var off = gfInOffsets[key] || 0;
                            gfInOffsets[key] = (off + dur) % vdur;
                            gfItems.push({
                                type: "product_video",
                                bin_name: v.name, bin_path: v.path || null,
                                time_seconds: t, duration: dur + GFPAD, in_offset: off,
                                win_start: v.winStart, win_len: vdur, // janela absoluta (região/in-out)
                                track: gfTrack, _autofill: true, _globalfill: true
                            });
                            added++;
                        } else if (q && q.images.length) {
                            var im = q.images[q.imgIdx % q.images.length]; q.imgIdx++;
                            gfItems.push({
                                type: "product_image",
                                bin_name: im.name, bin_path: im.path || null,
                                time_seconds: t, duration: dur + GFPAD, animation: "none",
                                track: gfTrack, _autofill: true, _globalfill: true,
                                _zoomPreset: (idx % 2 === 0) ? "ZOOMIN" : "ZOOMOUT"
                            });
                            added++;
                        }
                        t += dur; idx++;
                    }
                }
                return added;
            };

            if (gfHasMedia && gfSegments) {
                // ── MODO SEGMENTOS ─────────────────────────────────────────────
                // Resolve o start de cada segmento via frase, com cursor pra frente.
                var segCursor = 0;
                var gfResolved = [];
                gfSegments.forEach(function (s, si) {
                    var st = null;
                    if (s.start_phrase) {
                        st = findPhraseTime(s.start_phrase, segCursor);
                        if (st !== null) segCursor = st;
                    }
                    gfResolved.push({ start: st, folders: (s.folders || []).map(String) });
                    log("Global fill seg " + (si + 1) + ": '" + (s.start_phrase || "(sem frase)") + "' → " +
                        (st !== null ? st.toFixed(2) + "s" : "NÃO ENCONTRADA — segmento ignorado") +
                        " pastas=[" + ((s.folders || []).join(",") || "fim") + "]", st !== null ? "info" : "warn");
                });
                // Fim geral: end_phrase, senão fim da transcrição.
                var gfEndSeg = null;
                if (gf.end_phrase) {
                    var gfEP = findPhraseTime(gf.end_phrase, segCursor);
                    if (gfEP !== null) gfEndSeg = gfEP;
                    log("Global fill: end_phrase '" + gf.end_phrase + "' → " +
                        (gfEP !== null ? gfEP.toFixed(2) + "s" : "NÃO ENCONTRADA (usando fim da transcrição)"), "info");
                }
                if (gfEndSeg === null) {
                    var gfMx = 0;
                    transcriptWords.forEach(function (w) { if ((w.time || 0) > gfMx) gfMx = w.time; });
                    gfEndSeg = gfMx > 0 ? gfMx + gfSlot : segCursor + 300;
                }
                // Cada segmento resolvido enche até o PRÓXIMO segmento resolvido.
                for (var si = 0; si < gfResolved.length; si++) {
                    if (gfResolved[si].start === null) continue;
                    var spanStart = gfResolved[si].start;
                    var spanEnd = gfEndSeg;
                    for (var sj = si + 1; sj < gfResolved.length; sj++) {
                        if (gfResolved[sj].start !== null) { spanEnd = gfResolved[sj].start; break; }
                    }
                    var n = gfPushSpan(spanStart, spanEnd, gfResolved[si].folders);
                    if (gfResolved[si].folders.length) {
                        log("  » seg " + (si + 1) + " [" + spanStart.toFixed(1) + "→" + spanEnd.toFixed(1) +
                            "]s pastas=[" + gfResolved[si].folders.join(",") + "] → " + n + " slot(s)", "info");
                    }
                }
                log("Global fill (segmentos): " + gfItems.length + " slot(s) em " +
                    gfResolved.length + " segmento(s), slot=" + gfSlot + "s", "ok");

            } else if (gfHasMedia) {
                // ── MODO INTERCALADO (legado) ──────────────────────────────────
                var gfStart = 0;
                if (gf.start_phrase) {
                    var gfST = findPhraseTime(gf.start_phrase, 0);
                    if (gfST !== null) gfStart = gfST;
                    log("Global fill: start_phrase '" + gf.start_phrase + "' → " + (gfST !== null ? gfST.toFixed(2) + "s" : "NÃO ENCONTRADA (usando 0s)"), "info");
                }
                var gfEnd = null;
                if (gf.end_phrase) {
                    var gfET = findPhraseTime(gf.end_phrase, gfStart);
                    if (gfET !== null) gfEnd = gfET;
                    log("Global fill: end_phrase '" + gf.end_phrase + "' → " + (gfET !== null ? gfET.toFixed(2) + "s" : "NÃO ENCONTRADA (usando fim da transcrição)"), "info");
                }
                if (gfEnd === null) {
                    var gfMaxT = 0;
                    transcriptWords.forEach(function (w) { if ((w.time || 0) > gfMaxT) gfMaxT = w.time; });
                    gfEnd = gfMaxT > 0 ? gfMaxT + gfSlot : gfStart + 300;
                }
                gfPushSpan(gfStart, gfEnd, (gf.folders || []).map(String));
                log("Global fill (intercalado): " + gfItems.length + " slot(s) de " + gfFolders.join("+") +
                    " [" + gfStart.toFixed(1) + "s → " + gfEnd.toFixed(1) + "s] slot=" + gfSlot + "s", "ok");
            }

            if (gfItems.length) {
                // Produto virtual processado DEPOIS dos regulares → overwriteClip
                // sobrescreve o auto-fill sem conflito de _vidEnd.
                mountProducts.push({ folder: null, _virtual: true, timeline: gfItems });
            } else {
                log("Global fill: nenhum item gerado (bins sem mídia ou frases não encontradas)", "warn");
            }
        }

        // Reconstrói mountData com os novos timelines
        var newMountData = isMulti
            ? { products: mountProducts }
            : { product: mountProducts[0], timeline: mountProducts[0].timeline };
        if (keyPointFits.length) newMountData.key_point_fits = keyPointFits;
        if (ctaStarts.length)    newMountData.cta_starts     = ctaStarts;

        doMount(newMountData, btn);
    });
    }); // fecha o callback de getProductBinMedia
}

// Monta os itens visuais da recapitulação final (aba conclusion.recap).
// Para cada bloco (frase-âncora + lista de produtos), divide o tempo entre os
// produtos e gera: TRANSICAO_1 (entrada) + LOWERTHIRD com o nome + imagens gen_*
// em loop. Retorna um array de timeline items prontos (com time_seconds resolvido).
function buildRecapTimeline(mountProducts, conclusion, startCursor, slotDur, binMedia) {
    var out = [];
    if (!conclusion || !conclusion.recap || !conclusion.recap.length) return out;
    slotDur = (slotDur && slotDur > 0) ? slotDur : 5;
    binMedia = binMedia || {};

    // Index dos produtos por folder pra resolver gen_* e nome.
    var byFolder = {};
    mountProducts.forEach(function (p) {
        if (p.folder != null) byFolder[String(p.folder)] = p;
    });

    // 1. Resolve o tempo de início de cada bloco (cursor avança).
    var cursor = startCursor || 0;
    var blocks = [];
    conclusion.recap.forEach(function (entry, idx) {
        if (!entry.after_phrase) return;
        var t = findPhraseTime(entry.after_phrase, cursor);
        if (t === null) {
            log('recap ' + (idx + 1) + ': frase não encontrada (após t=' + cursor.toFixed(2) + 's): "' + entry.after_phrase + '"', "warn");
            return;
        }
        cursor = t;
        blocks.push({ start: t, products: entry.products || [] });
    });
    if (!blocks.length) return out;

    // 2. Fim de cada bloco = início do próximo. Último = end_phrase ou default.
    for (var i = 0; i < blocks.length; i++) {
        if (i < blocks.length - 1) {
            blocks[i].end = blocks[i + 1].start;
        } else {
            var e = null;
            if (conclusion.end_phrase) e = findPhraseTime(conclusion.end_phrase, blocks[i].start + 0.5);
            var n = Math.max(1, (blocks[i].products || []).length);
            blocks[i].end = (e !== null) ? e : (blocks[i].start + n * slotDur);
        }
    }

    // 3. Gera os itens por bloco/produto.
    blocks.forEach(function (blk) {
        var prods = blk.products || [];
        if (!prods.length || blk.end <= blk.start) return;
        var per = (blk.end - blk.start) / prods.length;

        prods.forEach(function (folderRef, pi) {
            var s0 = blk.start + pi * per;
            var s1 = (pi === prods.length - 1) ? blk.end : (s0 + per);
            var prod = byFolder[String(folderRef)];
            if (!prod) {
                log('recap: produto folder "' + folderRef + '" não encontrado', "warn");
                return;
            }
            var folder = (prod.folder || "").replace(/\//g, "\\");
            // Usa o layout de 2 linhas do LOWERTHIRD: INFO (pequena) = marca,
            // SUB-INFO (grande) = nome do modelo.
            var brand = prod.brand || "";
            var model = prod.name || ((prod.brand ? "" : "Produto"));
            if (!brand && model) { brand = model; model = ""; } // sem marca: nome na linha pequena

            // Transição de entrada
            out.push({
                type: "template_insert", template: "TRANSICAO_1",
                anchor: "marker", offset_seconds: 0, track: 5,
                time_seconds: s0, _recap: true
            });
            // Etiqueta com o nome (reusa LOWERTHIRD): marca + modelo
            out.push({
                type: "template_insert", template: "LOWERTHIRD",
                track: 3, time_seconds: s0, duration: Math.max(2, s1 - s0),
                text_overrides: { "INFO": brand, "SUB-INFO": model },
                _recap: true
            });
            // Imagens do BIN preenchendo [s0, s1] em loop.
            // Se não tiver imagens, faz loop dos VÍDEOS do bin (mesma lógica do auto-fill).
            var bmR = binMedia[String(folderRef)];
            var imgsR = (bmR && bmR.images) ? bmR.images : [];
            var vidsR = (bmR && bmR.videos) ? bmR.videos : [];
            if (imgsR.length > 0) {
                var nImgs = imgsR.length;
                var numSlots = Math.max(1, Math.ceil((s1 - s0) / slotDur));
                for (var k = 0; k < numSlots; k++) {
                    var t0 = s0 + k * slotDur;
                    var t1 = Math.min(t0 + slotDur, s1);
                    if (t1 - t0 < 0.2) break;
                    var imgEntryR = imgsR[k % nImgs];
                    out.push({
                        type: "product_image", bin_name: imgEntryR.name,
                        bin_path: imgEntryR.path || null,
                        time_seconds: t0, duration: t1 - t0, animation: "none",
                        track: 1, _autofill: true, _recap: true,
                        _zoomPreset: (k % 2 === 0) ? "ZOOMIN" : "ZOOMOUT"
                    });
                }
            } else if (vidsR.length > 0) {
                // Sem imagens — loop das JANELAS (regiões/in-out) pra cobrir [s0, s1].
                var vwinsR = vidsR.reduce(function (acc, v) { return acc.concat(_videoWindows(v)); }, []);
                var vcurR = s0;
                var loopIdxR = 0;
                var safetyR = (vwinsR.length || 1) * 50;
                var nVidLooped = 0;
                while (vcurR < s1 - 0.2 && safetyR-- > 0 && vwinsR.length) {
                    var rv = vwinsR[loopIdxR % vwinsR.length];
                    var rvdur = rv.winLen || 0;
                    if (!(rvdur > 0)) { loopIdxR++; continue; }
                    var thisDurR = Math.min(rvdur, s1 - vcurR);
                    out.push({
                        type: "product_video", bin_name: rv.name,
                        bin_path: rv.path || null,
                        time_seconds: vcurR, duration: thisDurR,
                        track: 1, _autofill: true, _recap: true,
                        win_start: rv.winStart, win_len: rvdur
                    });
                    vcurR += rvdur; loopIdxR++; nVidLooped++;
                }
                log('recap: produto folder "' + folderRef + '" sem imagens — usando ' + nVidLooped + ' vídeo(s) do bin em loop.', "info");
            } else {
                log('recap: produto folder "' + folderRef + '" sem imagens E sem vídeos no bin PROD_' + folderRef + ' — bloco sem mídia.', "warn");
            }
        });
    });

    return out;
}

// Monta os itens de PONTOS-CHAVE (key_points): pra cada gatilho, insere um stock
// aleatório (track 1) + um MOGRT por cima (track 2, ex: LIKE). A ilustração vai
// da frase-gatilho até o INÍCIO do próximo produto (sem invadir a introdução
// dele). Retorna { items, fits } — fits é a lista de ajustes de duração do MOGRT
// (esticar via speed/duration se for menor que a janela; cortar se for maior).
function buildKeyPointItems(keyPoints, durations, mountProducts) {
    var out = [], fits = [];
    var ctaStarts = [];
    if (!keyPoints || !keyPoints.length) return { items: out, fits: fits, ctaStarts: ctaStarts };
    var stockRoot = getStockFolder();
    var cursor = 0;

    // Início do PRÓXIMO produto após um tempo (menor PRODUTO time > ctaTime).
    function nextProductStart(after) {
        var best = null;
        (mountProducts || []).forEach(function (p) {
            (p.timeline || []).forEach(function (it) {
                if (it.type === "template_insert" && it.template &&
                    it.template.toUpperCase().indexOf("PRODUTO") >= 0 && it.time_seconds != null) {
                    var ts = it.time_seconds + (it.offset_seconds || 0);
                    if (ts > after + 0.1 && (best === null || ts < best)) best = ts;
                }
            });
        });
        return best;
    }

    keyPoints.forEach(function (kp, idx) {
        if (!kp.after_phrase) return;
        var t = findPhraseTime(kp.after_phrase, cursor);
        if (t === null) {
            log('ponto-chave ' + (idx + 1) + ': frase não encontrada: "' + kp.after_phrase + '"', "warn");
            return;
        }
        cursor = t;
        ctaStarts.push(t);

        // Transição de ENTRADA no CTA (ex: TRANSICAO_1) — corte do preço pro stock.
        // Alinhada ao marcador, no início do CTA. Track própria (default 5, igual
        // às outras transições, acima do conteúdo).
        if (kp.transition) {
            var transTrack = (kp.transition_track != null ? kp.transition_track : 5);
            out.push({
                type:         "template_insert",
                template:     kp.transition,
                anchor:       "marker",
                offset_seconds: 0,
                track:        transTrack,
                time_seconds: t,
                _keypoint:    true
            });
            log('ponto-chave ' + (idx + 1) + ' @ ' + t.toFixed(1) + 's (track ' + transTrack + '): transição ' + kp.transition, "info");
        }

        // Janela do CTA = da frase até o início do próximo produto (se houver).
        var nextStart = nextProductStart(t);
        var mogrtDur  = (kp.mogrt && durations[kp.mogrt]) ? durations[kp.mogrt]
                      : (kp.duration != null ? kp.duration : 5);
        if (!(mogrtDur > 0)) mogrtDur = 5;
        // Duração da ilustração: a janela inteira (não invade o produto seguinte);
        // sem próximo produto (ex: CTA do fim), usa a duração natural do MOGRT.
        var windowDur = (nextStart !== null) ? (nextStart - t) : null;
        var illusDur  = (windowDur !== null && windowDur > 0) ? windowDur : mogrtDur;

        // Stock aleatório (opcional) na track 1, limitado à janela.
        if (kp.stock_folder) {
            if (!stockRoot) {
                log('ponto-chave ' + (idx + 1) + ': stock_folder definido mas a "Pasta de stock videos" não foi configurada.', "warn");
            } else {
                var stockTrack = (kp.stock_track != null ? kp.stock_track : 1);
                var stockPath = pickRandomStock(stockRoot, kp.stock_folder);
                if (stockPath) {
                    out.push({
                        type:         "product_image", // reusa inserção de mídia (serve p/ vídeo)
                        file:         stockPath,
                        time_seconds: t,
                        duration:     illusDur,   // corta se o vídeo for MAIOR que a janela
                        animation:    "none",
                        track:        stockTrack,
                        _keypoint:    true
                    });
                    // Se o vídeo for MENOR que a janela, o host estica via speed/duration.
                    if (windowDur !== null && windowDur > 0) {
                        var stockName = stockPath.replace(/^.*[\\\/]/, ""); // basename (ex: 6.mp4)
                        fits.push({ time: t, track: stockTrack, target: windowDur, name: stockName });
                    }
                    log('ponto-chave ' + (idx + 1) + ' @ ' + t.toFixed(1) + 's (track ' + stockTrack + ', ' + illusDur.toFixed(1) + 's): stock ' + stockPath, "info");
                }
            }
        }

        // MOGRT por cima (ex: LIKE), track 2 — toca na duração NATURAL (sem speed/corte).
        if (kp.mogrt) {
            var mogrtTrack = (kp.mogrt_track != null ? kp.mogrt_track : 2);
            out.push({
                type:         "template_insert",
                template:     kp.mogrt,
                time_seconds: t,
                track:        mogrtTrack,
                _keypoint:    true
            });
            log('ponto-chave ' + (idx + 1) + ' @ ' + t.toFixed(1) + 's (track ' + mogrtTrack + '): MOGRT ' + kp.mogrt + ' (duração natural)', "info");
        }
    });

    return { items: out, fits: fits, ctaStarts: ctaStarts };
}

// ─── MOUNT (ExtendScript call) ────────────────────────────────────────────────

function doMount(mountData, btn) {
    var jsonStr = JSON.stringify(mountData).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    cs.evalScript('mountFromJSON("' + jsonStr + '")', function (raw) {
        btn.disabled    = false;
        btn.textContent = "Montar Vídeo";
        try {
            var result = JSON.parse(raw);
            if (result.error) {
                log("Erro na montagem: " + result.error, "error");
                return;
            }
            log("Montagem concluída — " + result.total + " item(s), " + result.errors + " erro(s).", result.errors > 0 ? "warn" : "ok");

            // Esticamento do PRECO (fecha buracos pós-preço)
            if (result.precoStretchLog && result.precoStretchLog.length) {
                result.precoStretchLog.forEach(function (entry) {
                    var tipo = (entry.indexOf("falha") >= 0 || entry.indexOf("erro") >= 0 || entry.indexOf("AINDA sobra") >= 0 || entry.indexOf("não localizado") >= 0) ? "warn" : "info";
                    log("  » PRECO-stretch: " + entry, tipo);
                });
            }

            // Ajuste de duração dos MOGRTs de ponto-chave (LIKE)
            if (result.keyPointFitLog && result.keyPointFitLog.length) {
                result.keyPointFitLog.forEach(function (entry) {
                    var tipo = (entry.indexOf("FALHOU") >= 0 || entry.indexOf("erro") >= 0 || entry.indexOf("não localizado") >= 0) ? "warn" : "info";
                    log("  » CTA-fit: " + entry, tipo);
                });
            }

            // Capítulos (YouTube): renderiza na aba e loga diagnóstico
            if (result.chaptersLog && result.chaptersLog.length) {
                result.chaptersLog.forEach(function (entry) { log("  » " + entry, "info"); });
            }
            if (result.chapters && result.chapters.length) {
                renderChapters(result.chapters);
                log("Capítulos gerados — veja a aba Capítulos (" + result.chapters.length + " capítulo(s)).", "ok");
            }
            result.results.forEach(function (r) {
                if (!r.success) {
                    log("  [p" + ((r.product || 0) + 1) + " item " + r.index + "] " + r.type + ": " + r.error, "error");
                }
                if (r.type === "template_insert" && r.updateLog && r.updateLog.length) {
                    r.updateLog.forEach(function (entry) {
                        var tipo = (entry.indexOf("FALHOU") >= 0 || entry.indexOf(" err") >= 0 || entry.indexOf("AVISO") >= 0) ? "warn" : "info";
                        log("    » " + entry, tipo);
                    });
                }
                // Log do MOGRT zoom pros product_image (insertMOGRTWithImage retorna isso)
                if ((r.type === "product_image" || r.type === "stock_image") && r.mogrt) {
                    var status = r.mediaReplaced ? "✓ REAL CHANGE" : "✗ não mudou de verdade";
                    log("    » [p" + ((r.product || 0) + 1) + " item " + r.index + "] MOGRT " + status,
                        r.mediaReplaced ? "info" : "warn");
                    // DIAG: mostra TODOS detalhes (temporário, pra investigar)
                    // Limita a APENAS o PRIMEIRO clip de cada produto pra não poluir muito
                    var isFirst = (r.index <= 3 && (r.product || 0) === 0);
                    if (r.updateLog && isFirst) {
                        r.updateLog.forEach(function(entry) {
                            log("      » " + entry, r.mediaReplaced ? "info" : "warn");
                        });
                    }
                }

                // Log do scaleToFrame pros product_image (insertMediaAtTime retorna isso)
                if ((r.type === "product_image" || r.type === "stock_image") && r.scaleToFrame) {
                    var sf = r.scaleToFrame;
                    var msg = "scaleToFrame: " + sf.method + (sf.scale ? " (scale=" + sf.scale.toFixed(1) + "%)" : "");
                    if (r.animation) {
                        msg += " | anim=" + r.animation.type + " base=" + r.animation.baseScale;
                        if (r.animation.transformFound === false) msg += " NO-TRANSFORM";
                        if (r.animation.actualScale !== undefined) msg += " tScale=" + r.animation.actualScale;
                        if (r.animation.numKeys !== undefined) msg += " keys=" + r.animation.numKeys;
                        if (r.animation.err) msg += " ERR:" + r.animation.err;
                        if (r.animation.diag) {
                            msg += " | diag step=" + r.animation.diag.step;
                            if (r.animation.diag.addMethods && r.animation.diag.addMethods.length)
                                msg += " tries=[" + r.animation.diag.addMethods.join(" | ") + "]";
                        }
                    }
                    log("    » [p" + ((r.product || 0) + 1) + " item " + r.index + "] " + msg, sf.ok ? "info" : "warn");
                }

                // Log do efeito "fundo borrado" pros product_video verticais/quadrados
                if (r.type === "product_video" && r.blurBg && r.blurBg.log && r.blurBg.log.length) {
                    var bgPrefix = r.blurBg.applied ? "✓ blur-bg" : "blur-bg";
                    log("    » [p" + ((r.product || 0) + 1) + " item " + r.index + "] " + bgPrefix + ": " + r.blurBg.log.join(" | "),
                        r.blurBg.applied ? "ok" : "info");
                }
            });
        } catch (e) {
            log("Erro inesperado: " + e.message, "error");
        }

        // ── POST-MOUNT: Aplica preset de zoom se ativado ─────────────────────
        // Coleta items com _zoomPreset, agrupa por preset name, chama applyPresetsFromBin
        var applyZoom = false;
        try { applyZoom = localStorage.getItem("autoeditor.applyZoomPreset") === "true"; } catch(e) {}
        if (applyZoom) {
            applyZoomPresetsAfterMount(mountData);
        }
    });
}

// Coleta items com _zoomPreset do mountData e dispara applyPresetsFromBin
// no ExtendScript. Roda após mount terminar com sucesso.
function applyZoomPresetsAfterMount(mountData) {
    var products = mountData.products || [mountData.product];
    var targets = [];
    products.forEach(function(prod) {
        (prod.timeline || []).forEach(function(item) {
            if (item._zoomPreset && item.time_seconds !== undefined) {
                // item.track no host já é usado como índice 0-based direto
                // (track=1 → V2). Não subtrair 1 aqui.
                targets.push({
                    trackIndex: (item.track !== undefined ? item.track : 1),
                    startSec:   item.time_seconds,
                    presetName: item._zoomPreset
                });
            }
        });
    });

    if (targets.length === 0) {
        log("Preset zoom: nenhum target encontrado (auto-fill rodou? checkbox ativo mas sem items?)", "warn");
        return;
    }

    log("Preset zoom: aplicando em " + targets.length + " clip(s)...", "info");

    var targetsJSON = JSON.stringify(targets).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    cs.evalScript('applyPresetsFromBin("' + targetsJSON + '")', function(raw) {
        try {
            var r = JSON.parse(raw);
            if (r.error) {
                log("Preset zoom ERRO: " + r.error, "error");
                return;
            }
            log("Preset zoom: " + r.applied + " aplicado(s), " + r.failed + " falhou(aram)",
                r.applied > 0 && r.failed === 0 ? "ok" : (r.applied > 0 ? "warn" : "error"));
            if (r.log && r.log.length) {
                r.log.forEach(function(entry) {
                    var tipo = (entry.indexOf("ERR") >= 0 || entry.indexOf("✗") >= 0) ? "warn" :
                               (entry.indexOf("✓") >= 0 ? "info" : "info");
                    log("  » " + entry, tipo);
                });
            }
        } catch(e) {
            log("Preset zoom parse err: " + e.message, "error");
        }
    });
}

// ─── PARSERS DE TRANSCRIÇÃO ───────────────────────────────────────────────────

// Remove acentos: "milímetros" → "milimetros", "rotações" → "rotacoes"
// U+0300–U+036F: combining diacritical marks
var _COMBINING = new RegExp("[" + String.fromCharCode(0x0300) + "-" + String.fromCharCode(0x036F) + "]", "g");
function accentFold(str) {
    return str.normalize("NFD").replace(_COMBINING, "");
}

// Parser do JSON de transcrição exportado pelo Premiere Pro
// Retorna array de { text, start, end } por palavra
function parsePremierTranscriptJSON(content) {
    var data  = JSON.parse(content);
    var words = [];
    (data.segments || []).forEach(function (seg) {
        (seg.words || []).forEach(function (w) {
            if (w.type !== "word" || !w.text) return;
            var clean = accentFold(w.text).toLowerCase().replace(/[^\w]/g, "");
            if (!clean) return;
            words.push({
                text:  clean,
                raw:   w.text,
                start: w.start,
                end:   w.start + w.duration
            });
        });
    });
    return words;
}

// Parser SRT / VTT — fallback quando não há JSON do Premiere
function parseSRT(content) {
    var entries = [];
    var blocks  = content.trim().split(/\r?\n\r?\n/);
    blocks.forEach(function (block) {
        var lines     = block.trim().split(/\r?\n/);
        if (lines.length < 2) return;
        var timeLine  = null;
        var textStart = 1;
        for (var i = 0; i < lines.length; i++) {
            if (/\d{2}:\d{2}:\d{2}[,\.]\d{3}\s*-->\s*/.test(lines[i])) {
                timeLine = lines[i]; textStart = i + 1; break;
            }
        }
        if (!timeLine) return;
        var m = timeLine.match(/(\d{2}):(\d{2}):(\d{2})[,\.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,\.](\d{3})/);
        if (!m) return;
        var start = +m[1]*3600 + +m[2]*60 + +m[3] + +m[4]/1000;
        var end   = +m[5]*3600 + +m[6]*60 + +m[7] + +m[8]/1000;
        var text  = lines.slice(textStart).join(" ").replace(/<[^>]+>/g, "").toLowerCase().trim();
        if (text) entries.push({ start: start, end: end, text: text });
    });
    return entries;
}

// Resolve after_phrase → timestamp
// Usa palavras (JSON Premiere) quando disponível; cai para SRT como fallback
//
// startAfterTime (opcional): só considera ocorrências CUJO timestamp seja >= startAfterTime.
// Isso evita matches duplicados entre produtos — ex: se "base é de aço estampado" aparece
// na narração do produto 1 E do produto 2, o produto 2 precisa pegar a SEGUNDA ocorrência.
// Sem esse parâmetro, voltava sempre o timestamp do produto 1 → desincronização.
// Normaliza um texto em "átomos": minúsculo, sem acento, e com espaços especiais
// (NBSP   etc.) e QUALQUER símbolo virando separador. Isso divide tokens
// colados pela transcrição — ex: "95 R$" → ["95","r"] — pra casar com a frase
// do agente escrita com espaço normal ("95 R$" → ["95","r"]).
function _phraseAtoms(s) {
    return accentFold(String(s == null ? "" : s)).toLowerCase()
        .replace(/[^\w\s]/g, " ")  // símbolos ($,%,°,&,vírgula…) → separador
        .split(/\s+/).filter(Boolean);
}

function findPhraseTime(phrase, startAfterTime) {
    var minStart = (typeof startAfterTime === "number") ? startAfterTime : -1;
    var phraseArr = _phraseAtoms(phrase);
    var n         = phraseArr.length;
    if (n === 0) return null;

    // ── Modo preciso: JSON do Premiere (palavra a palavra) ──────────────────
    if (transcriptWords.length > 0) {
        // (Re)monta o stream de átomos da transcrição, com cache por identidade.
        // Cada palavra pode gerar 1+ átomos (token colado é dividido); cada átomo
        // guarda o start da palavra de origem.
        if (_atomCacheSrc !== transcriptWords || !_atomCache) {
            _atomCache = [];
            for (var k = 0; k < transcriptWords.length; k++) {
                // USA .raw (texto original, ex: "95 R$") e NÃO .text — o parser
                // pré-limpa o .text removendo NBSP/símbolos, gerando "95r" colado, o
                // que impediria dividir em ["95","r"] pra casar com a frase do agente.
                var sub = _phraseAtoms(transcriptWords[k].raw != null ? transcriptWords[k].raw : transcriptWords[k].text);
                for (var a = 0; a < sub.length; a++) {
                    _atomCache.push({ w: sub[a], start: transcriptWords[k].start });
                }
            }
            _atomCacheSrc = transcriptWords;
        }
        var atoms = _atomCache;
        for (var i = 0; i <= atoms.length - n; i++) {
            if (atoms[i].start < minStart) continue;
            var match = true;
            for (var j = 0; j < n; j++) {
                if (atoms[i + j].w !== phraseArr[j]) { match = false; break; }
            }
            if (match) return atoms[i].start;
        }
        return null;
    }

    // ── Fallback: SRT ────────────────────────────────────────────────────────
    var p = phraseArr.join(" ");
    for (var i = 0; i < srtEntries.length; i++) {
        if (srtEntries[i].start < minStart) continue;
        if (srtEntries[i].text.indexOf(p) >= 0) return srtEntries[i].start;
    }
    for (var i = 0; i < srtEntries.length - 1; i++) {
        if (srtEntries[i].start < minStart) continue;
        if ((srtEntries[i].text + " " + srtEntries[i+1].text).indexOf(p) >= 0) return srtEntries[i].start;
    }
    return null;
}

// ─── TEMPLATES ────────────────────────────────────────────────────────────────

function initTemplates() {
    document.getElementById("btn-refresh-templates").addEventListener("click", refreshTemplates);
}

// Storage key pra preferência "expandir template" por nome de template
function getTemplateExpandPref(label) {
    try {
        return localStorage.getItem("autoeditor.expand." + label) === "true";
    } catch (e) { return false; }
}
function setTemplateExpandPref(label, value) {
    try {
        localStorage.setItem("autoeditor.expand." + label, value ? "true" : "false");
    } catch (e) {}
}

// Retorna mapa { TEMPLATE_LABEL: true/false } com prefs salvas pra todos templates
// conhecidos. Usado pra repassar pro ExtendScript no momento do mount.
function getAllExpandPrefs() {
    var prefs = {};
    try {
        for (var i = 0; i < localStorage.length; i++) {
            var key = localStorage.key(i);
            if (key && key.indexOf("autoeditor.expand.") === 0) {
                var lbl = key.substring("autoeditor.expand.".length);
                prefs[lbl] = localStorage.getItem(key) === "true";
            }
        }
    } catch (e) {}
    return prefs;
}

function refreshTemplates() {
    cs.evalScript("getTemplatesInfo()", function (raw) {
        try {
            var data = JSON.parse(raw);
            var list = document.getElementById("templates-list");
            if (data && data.error) {
                list.innerHTML = '<div class="error-msg">' + esc(data.error) + '</div>';
                return;
            }
            var templates = (data && data.length !== undefined) ? data : [];

            if (!templates.length) {
                list.innerHTML = '<div class="empty">Nenhuma sequência com prefixo [TEMPLATE] encontrada.</div>';
                return;
            }
            var html = "";
            templates.forEach(function (t) {
                var label    = t.label || t.name;
                var kind     = t.kind || "sequence";
                var labelEsc = esc(label).replace(/'/g, "&#39;");

                var info;
                if (kind === "masterclip") {
                    info = '<span class="template-kind-badge masterclip">MasterClip</span>';
                } else {
                    var duration = (t.duration || 0).toFixed(1);
                    info = '<span class="template-kind-badge sequence">Sequence</span>' +
                           '<span class="template-info">' + t.videoTracks + ' track' + (t.videoTracks !== 1 ? "s" : "") +
                           " • " + t.clips + " clip" + (t.clips !== 1 ? "s" : "") +
                           " • " + duration + "s</span>";
                }

                // Toggle de expand só faz sentido pra Sequence
                var toggleHtml = "";
                if (kind === "sequence") {
                    var checked = getTemplateExpandPref(label) ? "checked" : "";
                    toggleHtml =
                        '<label class="template-expand-toggle">' +
                            '<input type="checkbox" ' + checked +
                                ' onchange="onTemplateExpandToggle(\'' + labelEsc + '\', this.checked)">' +
                            '<span>Expandir conteúdo na timeline (animações responsívas do MOGRT)</span>' +
                        '</label>';
                } else {
                    toggleHtml =
                        '<div class="template-info-hint">' +
                            'Modo direto: insere clip + substitui texto. Animações responsívas funcionam nativamente, cores/posição preservadas do MasterClip.' +
                        '</div>';
                }

                html += '<div class="template-card">' +
                    '<div class="template-header">' +
                        '<strong>' + esc(label) + '</strong>' +
                        '<span class="template-meta">' + info + '</span>' +
                    '</div>' +
                    toggleHtml +
                    '<button onclick="insertTemplateNow(\'' + labelEsc + '\')" class="btn-template-insert">Inserir agora (t=0)</button>' +
                    '</div>';
            });
            list.innerHTML = html;
        } catch (e) {
            document.getElementById("templates-list").innerHTML = '<div class="error-msg">' + esc(e.message) + '</div>';
        }
    });
}

// Chamado pelo onchange do checkbox de expand
function onTemplateExpandToggle(label, checked) {
    setTemplateExpandPref(label, checked);
    log('Template "' + label + '": expand = ' + (checked ? 'ON' : 'OFF'), "info");
}

function insertTemplateNow(templateName) {
    var escaped = templateName.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    cs.evalScript('insertTemplate("' + escaped + '", 1, 0)', function (raw) {
        try {
            var r = JSON.parse(raw);
            log(r.error ? "Erro: " + r.error : 'Template "' + templateName + '" inserido na timeline.', r.error ? "error" : "ok");
        } catch (e) { log("Erro: " + e.message, "error"); }
    });
}

// ─── CONFIG ───────────────────────────────────────────────────────────────────

function initConfig() { /* sem configurações extras por ora */ }

function loadConfig() {
    var rootPath = localStorage.getItem("root_folder") || "";
    if (rootPath && document.getElementById("root-folder")) {
        document.getElementById("root-folder").value = rootPath;
        updateRootFolderStatus(rootPath);
    }
}

function saveConfig() { /* sem configurações extras por ora */ }

// ─── LOG ──────────────────────────────────────────────────────────────────────

function copyLog() {
    var lines = document.querySelectorAll("#log .log-line");
    var text  = Array.prototype.map.call(lines, function (l) { return l.textContent; }).join("\n");
    if (!text) { log("Log está vazio.", "warn"); return; }
    var ta = document.createElement("textarea");
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.value = text;
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) {}
    document.body.removeChild(ta);
    log(ok ? "Log copiado para a área de transferência." : "Falha — selecione o log e copie manualmente.", ok ? "ok" : "warn");
}

function clearLog() {
    document.getElementById("log").innerHTML = "";
}

function log(msg, type) {
    var box  = document.getElementById("log");
    var line = document.createElement("div");
    line.className = "log-line " + (type || "info");
    var time = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    line.textContent = "[" + time + "] " + msg;
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
}

// ─── UTIL ─────────────────────────────────────────────────────────────────────

function esc(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
