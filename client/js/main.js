// Auto Editor - Panel Logic

var cs          = new CSInterface();
var loadedJSON  = null;  // objeto JSON de mapeamento carregado
var transcriptWords = []; // palavras com timestamps (Premiere JSON) — modo preciso
var srtEntries  = [];    // entradas SRT — fallback

// Chave do projeto atual no localStorage (preenchida em initProjectPersistence)
var _projectKey = "autoeditor_default";

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
            if (btn.dataset.tab === "recursos")  refreshTemplateSeqSection();
        });
    });
}

// ─── CAPÍTULOS (YouTube) ────────────────────────────────────────────────────

function initCapitulos() {
    var btn = document.getElementById("btn-copy-chapters");
    if (btn) btn.addEventListener("click", function () {
        var ta = document.getElementById("chapters-text");
        var status = document.getElementById("chapters-copy-status");
        if (!ta || !ta.value.trim()) {
            if (status) status.textContent = "nada pra copiar";
            return;
        }
        ta.select();
        var ok = false;
        try { ok = document.execCommand("copy"); } catch (e) {}
        if (status) status.textContent = ok ? "copiado!" : "selecione e copie manualmente (Ctrl+C)";
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

// Preenche a aba Capítulos com as linhas no formato do YouTube.
function renderChapters(chapters) {
    var ta = document.getElementById("chapters-text");
    if (!ta || !chapters || !chapters.length) return;
    var lines = chapters.map(function (c) {
        return fmtTimestamp(c.time) + " " + (c.title || "");
    });
    ta.value = lines.join("\n");
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
    var tplBtn = document.getElementById("btn-create-templates");
    if (tplBtn) tplBtn.addEventListener("click", createTemplateSequencesAction);
    refreshTemplateSeqSection();

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
function downloadYTToFolder(folder, url, onProgress, onDone) {
    if (!url) { onDone(new Error("Cole uma URL do YouTube primeiro.")); return; }
    var extDir = getExtensionRootClient();
    cs.evalScript("getProjectDir()", function (rawPrj) {
        var prjDir = "";
        try { var rp = JSON.parse(rawPrj); prjDir = rp.dir || ""; } catch (e) {}
        if (!prjDir) {
            onDone(new Error("Salve o projeto antes (a pasta AutoEditor_Downloads vai ao lado do .prproj)."));
            return;
        }
        runYtDlp(url, folder, extDir, prjDir, onProgress, onDone);
    });
}

// Baixa o vídeo via yt-dlp. Entrega o caminho final via onDone(err, path).
// onProgress(text) é chamado a cada 5% pra atualizar a UI (ex: rótulo do botão).
function runYtDlp(url, folder, extDir, prjDir, onProgress, onDone) {
    function fail(msg) { onDone(new Error(msg)); }
    var cp   = tryNodeRequire('child_process');
    var fs   = tryNodeRequire('fs');
    var pmod = tryNodeRequire('path');
    if (!cp || !fs || !pmod) { fail("Node child_process/fs/path indisponíveis."); return; }

    var outDir = pmod.join(prjDir, "AutoEditor_Downloads", "PROD_" + folder);
    try { fs.mkdirSync(outDir, { recursive: true }); }
    catch (e) { fail("Erro criando pasta '" + outDir + "': " + e.message); return; }

    var bundled = extDir ? pmod.join(extDir, "bin", "yt-dlp.exe") : "";
    var hasBundled = false;
    try { hasBundled = !!(bundled && fs.existsSync(bundled)); } catch (e) {}
    var ytdlp = hasBundled ? bundled : "yt-dlp";

    recLog(hasBundled ? "yt-dlp: embutido" : "yt-dlp: PATH");
    recLog("Baixando → PRODUTO " + folder + " | " + url);

    detectFfmpeg(function (ff) {
        var formatSel, extraArgs = [];
        if (ff.ok) {
            recLog("ffmpeg: " + (ff.dir ? "embutido" : "PATH") + " — qualidade alta (merge vídeo+áudio).");
            formatSel = "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best";
            extraArgs = ["--merge-output-format", "mp4"];
            if (ff.dir) extraArgs.push("--ffmpeg-location", ff.dir);
        } else {
            recLog("⚠ ffmpeg não encontrado — caindo pra MP4 progressivo (~360p no YouTube novo).", "warn");
            formatSel = "best[ext=mp4][acodec!=none][vcodec!=none]/best[acodec!=none][vcodec!=none]";
        }

        var args = ["-f", formatSel].concat(extraArgs).concat([
            "--no-playlist", "--restrict-filenames", "--no-warnings",
            "-o", pmod.join(outDir, "%(title)s.%(ext)s"),
            "--print", "after_move:%(filepath)s",
            url
        ]);

        var ytFinalPath = "", lastPctReported = -1;
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
            if (!ytFinalPath && /^[A-Za-z]:[\\\/]/.test(s) && /\.(mp4|mkv|webm|m4a)$/i.test(s)) {
                ytFinalPath = s;
                return;
            }
            if (/^ERROR\b/i.test(s)) { recLog(s, "err"); return; }
            if (/^WARNING\b/i.test(s)) { recLog(s, "warn"); return; }
        }
        function drain(chunk, sink) {
            sink.buf += chunk.toString();
            var idx;
            while ((idx = sink.buf.indexOf("\n")) >= 0) {
                processLine(sink.buf.substring(0, idx));
                sink.buf = sink.buf.substring(idx + 1);
            }
        }
        var outSink = { buf: "" }, errSink = { buf: "" };

        var ch;
        try { ch = cp.spawn(ytdlp, args, { windowsHide: true }); }
        catch (eSp) { fail("Falha ao iniciar yt-dlp: " + eSp.message); return; }
        ch.stdout.on("data", function (d) { drain(d, outSink); });
        ch.stderr.on("data", function (d) { drain(d, errSink); });
        ch.on("error", function (e) { fail("Erro yt-dlp: " + e.message); });
        ch.on("close", function (code) {
            if (outSink.buf) processLine(outSink.buf);
            if (errSink.buf) processLine(errSink.buf);
            if (code !== 0) { fail("yt-dlp encerrou com código " + code); return; }
            if (!ytFinalPath || !fs.existsSync(ytFinalPath)) {
                try {
                    var entries = fs.readdirSync(outDir).map(function (n) {
                        var p = pmod.join(outDir, n);
                        var st = fs.statSync(p);
                        return { p: p, m: st.mtimeMs, isFile: st.isFile() };
                    }).filter(function (e) { return e.isFile && /\.(mp4|mkv|webm|m4a)$/i.test(e.p); });
                    entries.sort(function (a, b) { return b.m - a.m; });
                    if (entries.length) ytFinalPath = entries[0].p;
                } catch (eF) {}
            }
            if (!ytFinalPath) { fail("Download terminou mas não localizei o arquivo final."); return; }
            recLog("✓ Baixado: " + ytFinalPath, "ok");
            onDone(null, ytFinalPath);
        });
    });
}

function recIsImage(path) {
    var m = String(path).toLowerCase().match(/\.([a-z0-9]+)$/);
    return !!(m && REC_IMG_EXTS.indexOf(m[1]) >= 0);
}
function recBaseName(path) {
    return String(path).replace(/[\\\/]+$/, "").split(/[\\\/]/).pop();
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

function renderProductCard(n) {
    var container = document.getElementById("products-container");
    var card = document.createElement("div");
    card.style.cssText = "border:1px solid #444;border-radius:6px;padding:10px;margin-top:10px;background:#2a2a2a";

    var files = [];      // {path, name, isImage}
    var refPath = null;  // imagem marcada como referência (png)

    var title = document.createElement("div");
    title.style.cssText = "font-weight:bold;margin-bottom:6px";
    title.textContent = "PRODUTO " + n;
    card.appendChild(title);

    var drop = document.createElement("div");
    drop.style.cssText = "border:2px dashed #555;border-radius:6px;padding:14px;text-align:center;color:#999;cursor:pointer;margin-bottom:8px";
    drop.textContent = "Arraste vídeos e imagens aqui, ou clique para selecionar";
    card.appendChild(drop);

    // Barra "ou cole URL do YouTube" — baixa direto na pasta deste PROD_N e
    // adiciona o arquivo final na lista do card.
    var ytWrap = document.createElement("div");
    ytWrap.style.cssText = "display:flex;gap:6px;margin-bottom:8px";
    var ytIn = document.createElement("input");
    ytIn.type = "text";
    ytIn.placeholder = "...ou cole URL do YouTube";
    ytIn.style.cssText = "flex:1;padding:5px 8px;background:#1e1e1e;color:#ddd;border:1px solid #444;border-radius:4px";
    var ytBtn = document.createElement("button");
    ytBtn.textContent = "Baixar";
    ytBtn.style.cssText = "min-width:80px";
    ytWrap.appendChild(ytIn);
    ytWrap.appendChild(ytBtn);
    card.appendChild(ytWrap);

    ytBtn.addEventListener("click", function () {
        var url = (ytIn.value || "").trim();
        if (!url) { recLog("Cole uma URL do YouTube primeiro.", "warn"); return; }
        ytBtn.disabled = true; ytIn.disabled = true;
        var originalLabel = ytBtn.textContent;
        ytBtn.textContent = "Baixando…";
        downloadYTToFolder(n, url,
            function onProgress(label) { ytBtn.textContent = label; },
            function onDone(err, filePath) {
                ytBtn.disabled = false; ytIn.disabled = false;
                ytBtn.textContent = originalLabel;
                if (err) { recLog("✗ " + err.message, "err"); return; }
                ytIn.value = "";
                addPaths([filePath]); // entra na lista do card como qualquer outro arquivo
            }
        );
    });
    ytIn.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); ytBtn.click(); }
    });

    var listEl = document.createElement("div");
    listEl.style.cssText = "font-family:monospace;font-size:11px;margin-bottom:8px";
    card.appendChild(listEl);

    var actions = document.createElement("div");
    actions.className = "row-space";
    var createBtn = document.createElement("button");
    createBtn.className = "btn-primary flex1";
    createBtn.textContent = "Criar PRODUTO " + n;
    createBtn.disabled = true;
    var cancelBtn = document.createElement("button");
    cancelBtn.className = "flex1";
    cancelBtn.textContent = "Cancelar";
    actions.appendChild(createBtn);
    actions.appendChild(cancelBtn);
    card.appendChild(actions);

    container.appendChild(card);
    _pendingProductCard = card;

    function releaseAddBtn() {
        _pendingProductCard = null;
        var addBtn = document.getElementById("btn-add-product");
        if (addBtn) addBtn.disabled = false;
    }

    function renderList() {
        listEl.innerHTML = "";
        if (!files.length) {
            listEl.innerHTML = "<span style='color:#777'>nenhum arquivo adicionado</span>";
            createBtn.disabled = true;
            return;
        }
        // garante uma referência válida (1ª imagem, se houver)
        if (!refPath || !files.some(function (f) { return f.path === refPath; })) {
            var firstImg = files.filter(function (f) { return f.isImage; })[0];
            refPath = firstImg ? firstImg.path : null;
        }
        files.forEach(function (f) {
            var row = document.createElement("div");
            row.style.cssText = "display:flex;align-items:center;gap:6px;padding:2px 0";

            var tag = document.createElement("span");
            tag.textContent = f.isImage ? "🖼" : "🎬";
            row.appendChild(tag);

            var nameSpan = document.createElement("span");
            nameSpan.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
            nameSpan.textContent = f.name;
            row.appendChild(nameSpan);

            if (f.isImage) {
                var lbl = document.createElement("label");
                lbl.style.cssText = "font-size:10px;color:#9cf;cursor:pointer;white-space:nowrap";
                var radio = document.createElement("input");
                radio.type = "radio";
                radio.name = "ref_prod_" + n;
                radio.checked = (f.path === refPath);
                radio.addEventListener("change", function () { refPath = f.path; });
                lbl.appendChild(radio);
                lbl.appendChild(document.createTextNode(" ref (png)"));
                row.appendChild(lbl);
            }

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
        createBtn.disabled = false;
    }

    function addPaths(paths) {
        (paths || []).forEach(function (p) {
            if (!p) return;
            if (files.some(function (f) { return f.path === p; })) return;
            files.push({ path: p, name: recBaseName(p), isImage: recIsImage(p) });
        });
        renderList();
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

    cancelBtn.addEventListener("click", function () {
        try { container.removeChild(card); } catch (e) {}
        releaseAddBtn();
    });

    createBtn.addEventListener("click", function () {
        if (!files.length) return;
        createBtn.disabled = true; cancelBtn.disabled = true;
        var paths = files.map(function (f) { return f.path; });
        var arg = JSON.stringify(n) + "," +
                  JSON.stringify(JSON.stringify(paths)) + "," +
                  JSON.stringify(refPath || "");
        recLog("Criando PRODUTO " + n + " com " + paths.length + " arquivo(s)…");
        cs.evalScript("addProductMedia(" + arg + ")", function (raw) {
            var r = {};
            try { r = JSON.parse(raw); } catch (e) {}
            if (r && r.ok) {
                var msg = "✓ PRODUTO " + n + " criado — " + r.imported + " importado(s)";
                if (r.failed && r.failed.length) msg += ", " + r.failed.length + " falhou";
                msg += " | referência: " + r.ref;
                recLog(msg, "ok");
                drop.style.display = "none";
                listEl.style.opacity = "0.6";
                title.textContent = "✓ PRODUTO " + n + " (criado)";
                createBtn.style.display = "none";
                cancelBtn.style.display = "none";
            } else {
                recLog("✗ Erro ao criar PRODUTO " + n + ": " + (r.error || raw), "err");
                createBtn.disabled = false; cancelBtn.disabled = false;
            }
            releaseAddBtn();
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
        rootFolder:     document.getElementById("root-folder").value || "",
        transcriptPath: _savedTranscriptPath || "",
        jsonPath:       _savedJsonPath       || ""
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
            try {
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
            } catch (err) {
                log("JSON inválido: " + err.message, "error");
            }
        });
    };
    input.click();
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
    log("Exportando transcrição do Premiere...", "info");
    var btn = document.getElementById("btn-export-srt");
    btn.disabled = true;

    cs.evalScript("getTempFolder()", function (raw) {
        var tempFolder = raw.replace(/^"|"$/g, "").replace(/\\\\/g, "\\");
        var srtPath    = tempFolder + "\\autoeditor_transcription.srt";
        var escaped    = srtPath.replace(/\\/g, "\\\\");

        cs.evalScript('exportTranscription("' + escaped + '")', function (result) {
            btn.disabled = false;
            try {
                var data = JSON.parse(result);
                if (data.error) {
                    log(data.error, "error");
                    document.getElementById("srt-status").textContent = "Falhou — carregue manualmente";
                    document.getElementById("srt-status").className = "badge error";
                } else {
                    srtEntries = parseSRT(data.content);
                    document.getElementById("srt-status").textContent = srtEntries.length + " entradas exportadas";
                    document.getElementById("srt-status").className = "badge ok";
                    log("Transcrição exportada: " + srtEntries.length + " entradas.", "ok");
                    updateMountButton();
                }
            } catch (e) {
                log("Erro ao processar transcrição: " + e.message, "error");
                btn.disabled = false;
            }
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
        var n = String(val || '').replace(/^R\$\s*/i, '').trim();
        if (!n) return '';
        return n.indexOf(',') >= 0 ? n : n + ',00';
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

    // Remove prefixo "R$ " (ou "R$") e garante sufixo ",00"
    function priceNum(val) {
        var n = String(val || '').replace(/^R\$\s*/i, '').trim();
        if (!n) return '';
        // Se já tem vírgula (ex: "330,50"), mantém; senão adiciona ",00"
        return n.indexOf(',') >= 0 ? n : n + ',00';
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
        var n = String(val || '').replace(/^R\$\s*/i, '').trim();
        if (!n) return '';
        return n.indexOf(',') >= 0 ? n : n + ',00';
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
    var __folders = [];
    mountProducts.forEach(function (p) { if (p.folder != null) __folders.push(String(p.folder)); });
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

            // Encontra PRODUTO e PRECO
            var produtoItem = null, precoItem = null;
            prod.timeline.forEach(function(item) {
                if (item.type !== "template_insert" || item.time_seconds === undefined) return;
                if (item.template && item.template.toUpperCase().indexOf("PRODUTO") >= 0 && !produtoItem) produtoItem = item;
                if (item.template && item.template.toUpperCase().indexOf("PRECO") >= 0) precoItem = item;
            });
            if (!produtoItem || !precoItem) {
                log("p" + (pIdx+1) + ": auto-fill ignorado (PRODUTO ou PRECO não encontrado/resolvido)", "warn");
                return;
            }

            var produtoDur = durations[produtoItem.template] || 5;
            var fillStart  = produtoItem.time_seconds + produtoDur;
            var fillEnd    = precoItem.time_seconds;
            var fillDur    = fillEnd - fillStart;
            if (fillDur < 1) {
                log("p" + (pIdx+1) + ": auto-fill pulado (gap muito pequeno: " + fillDur.toFixed(2) + "s)", "warn");
                return;
            }

            var track = produtoItem.track || 1;
            var addedItems = [];

            // ── VÍDEOS DO BIN: entram PRIMEIRO, na duração natural (cortado no preço).
            var imgStart = fillStart;
            if (bm.videos.length) {
                var vcursor = fillStart, nVid = 0;
                for (var vi = 0; vi < bm.videos.length; vi++) {
                    if (vcursor >= fillEnd - 0.2) break;
                    var vdurFull = bm.videos[vi].dur || 0;
                    if (!(vdurFull > 0)) {
                        log("p" + (pIdx+1) + ": vídeo '" + bm.videos[vi].name + "' com duração 0 (codec não medido?) — pulado.", "warn");
                        continue;
                    }
                    var vdur = Math.min(vdurFull, fillEnd - vcursor); // corta o último se passar
                    addedItems.push({
                        type: "product_video", bin_name: bm.videos[vi].name,
                        time_seconds: vcursor, duration: vdur, track: track, _autofill: true
                    });
                    vcursor += vdurFull; nVid++;
                }
                imgStart = Math.min(vcursor, fillEnd);
                log("p" + (pIdx+1) + ": " + nVid + " vídeo(s) do bin (" + bm.videoTotal.toFixed(1) + "s) — imagens preenchem de " + imgStart.toFixed(1) + "s a " + fillEnd.toFixed(1) + "s", "info");
            }

            // ── IMAGENS DO BIN: em loop, preenchendo o resto até o preço.
            var nImg = bm.images.length;
            var imgFillDur = fillEnd - imgStart;
            var numSlots = (imgFillDur > 0.2 && nImg >= 1) ? Math.ceil(imgFillDur / slotDur) : 0;
            for (var i = 0; i < numSlots; i++) {
                var t0 = imgStart + i * slotDur;
                var t1 = Math.min(t0 + slotDur, fillEnd);
                if (t1 - t0 < 0.2) break;
                addedItems.push({
                    type: "product_image", bin_name: bm.images[i % nImg].name,
                    time_seconds: t0, duration: t1 - t0, animation: "none",
                    track: track, _autofill: true,
                    _zoomPreset: (i % 2 === 0) ? "ZOOMIN" : "ZOOMOUT"
                });
            }
            if (imgFillDur > 0.2 && nImg < 1) {
                log("p" + (pIdx+1) + ": vídeos terminaram em " + imgStart.toFixed(1) + "s mas o bin não tem imagens pra preencher até " + fillEnd.toFixed(1) + "s.", "warn");
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
        for (var pf = 0; pf < mountProducts.length - 1; pf++) {
            var prodA = mountProducts[pf];
            var bmA = binMedia[String(prodA.folder)];
            if (!bmA || !bmA.images || bmA.images.length === 0) continue; // sem imagens no bin pra preencher

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

            var nImgsA  = bmA.images.length;
            var trackA  = precoA.track || 1;
            var fillItems = [];
            var nSlotsPF = Math.ceil(gapPF / slotDur);
            for (var kf = 0; kf < nSlotsPF; kf++) {
                var ft0 = stretchEnd + kf * slotDur;
                var ft1 = Math.min(ft0 + slotDur, nextStartPF);
                if (ft1 - ft0 < 0.2) break;
                fillItems.push({
                    type: "product_image", bin_name: bmA.images[kf % nImgsA].name,
                    time_seconds: ft0, duration: ft1 - ft0, animation: "none",
                    track: trackA, _autofill: true, _postpreco: true,
                    _zoomPreset: (kf % 2 === 0) ? "ZOOMIN" : "ZOOMOUT"
                });
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
            // Imagens do BIN preenchendo [s0, s1] em loop
            var bmR = binMedia[String(folderRef)];
            var imgsR = (bmR && bmR.images) ? bmR.images : [];
            if (imgsR.length === 0) {
                log('recap: produto folder "' + folderRef + '" sem imagens no bin PROD_' + folderRef + ' — bloco sem imagens.', "warn");
            } else {
                var nImgs = imgsR.length;
                var numSlots = Math.max(1, Math.ceil((s1 - s0) / slotDur));
                for (var k = 0; k < numSlots; k++) {
                    var t0 = s0 + k * slotDur;
                    var t1 = Math.min(t0 + slotDur, s1);
                    if (t1 - t0 < 0.2) break;
                    out.push({
                        type: "product_image", bin_name: imgsR[k % nImgs].name,
                        time_seconds: t0, duration: t1 - t0, animation: "none",
                        track: 1, _autofill: true, _recap: true,
                        _zoomPreset: (k % 2 === 0) ? "ZOOMIN" : "ZOOMOUT"
                    });
                }
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
function findPhraseTime(phrase, startAfterTime) {
    var p = accentFold(phrase).toLowerCase().trim().replace(/[^\w\s]/g, "");
    var minStart = (typeof startAfterTime === "number") ? startAfterTime : -1;

    // ── Modo preciso: JSON do Premiere (palavra a palavra) ──────────────────
    if (transcriptWords.length > 0) {
        var phraseArr = p.split(/\s+/).filter(Boolean);
        var n         = phraseArr.length;

        // Match exato (após minStart)
        for (var i = 0; i <= transcriptWords.length - n; i++) {
            if (transcriptWords[i].start < minStart) continue;
            var match = true;
            for (var j = 0; j < n; j++) {
                if (transcriptWords[i + j].text !== phraseArr[j]) { match = false; break; }
            }
            if (match) return transcriptWords[i].start;
        }

        // Match parcial (ignora pontuação residual)
        for (var i = 0; i <= transcriptWords.length - n; i++) {
            if (transcriptWords[i].start < minStart) continue;
            var match = true;
            for (var j = 0; j < n; j++) {
                var wClean = transcriptWords[i + j].text.replace(/[^\w]/g, "");
                if (wClean !== phraseArr[j]) { match = false; break; }
            }
            if (match) return transcriptWords[i].start;
        }

        return null;
    }

    // ── Fallback: SRT ────────────────────────────────────────────────────────
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
