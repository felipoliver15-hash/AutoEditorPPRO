// Auto Editor - ExtendScript Host
// Premiere Pro 2025

var TICKS_PER_SECOND = 254016000000;

// Log temporário usado por replaceClipWithImage pra reportar resultado de Scale to Frame Size
// pra updateTemplatePlaceholders, que então anexa ao log retornado pra UI.
var _globalScaleLog = null;

function toTicks(seconds) {
    return String(Math.round(seconds * TICKS_PER_SECOND));
}

// ─── UTILITÁRIOS ──────────────────────────────────────────────────────────────

function ping() {
    try {
        return JSON.stringify({
            ok: true,
            version: app.version,
            project: app.project ? app.project.name : null,
            sequence: (app.project && app.project.activeSequence) ? app.project.activeSequence.name : null
        });
    } catch (e) {
        return JSON.stringify({ ok: false, error: e.message });
    }
}

function getAllSequences() {
    try {
        var result = [];
        var n = app.project.sequences.numSequences;
        for (var i = 0; i < n; i++) {
            var s = app.project.sequences[i];
            result.push({ id: s.sequenceID, name: s.name });
        }
        return JSON.stringify(result);
    } catch (e) {
        return JSON.stringify({ error: e.message });
    }
}

// Retorna info detalhada dos templates [TEMPLATE]*: nome, kind (sequence ou
// masterclip), tracks/clips/duração quando sequence. Usado pela aba Templates
// pra mostrar lista + toggles.
function getTemplatesInfo() {
    try {
        var TPS = 254016000000;
        var result = [];
        var seenNames = {};

        // 1. Sequências [TEMPLATE]*
        var n = app.project.sequences.numSequences;
        for (var i = 0; i < n; i++) {
            var s = app.project.sequences[i];
            if (s.name.indexOf("[TEMPLATE]") !== 0) continue;
            var label = s.name.replace("[TEMPLATE] ", "").replace("[TEMPLATE]", "")
                              .replace(/^\s+|\s+$/g, "");
            var usedVTracks = 0;
            var totalClips  = 0;
            var maxEndTicks = 0;
            for (var t = 0; t < s.videoTracks.numTracks; t++) {
                var tr = s.videoTracks[t];
                if (tr.clips.numItems === 0) continue;
                usedVTracks++;
                totalClips += tr.clips.numItems;
                for (var c = 0; c < tr.clips.numItems; c++) {
                    var clip = tr.clips[c];
                    try {
                        var endTicks = parseFloat(clip.end.ticks);
                        if (!isNaN(endTicks) && endTicks > maxEndTicks) maxEndTicks = endTicks;
                    } catch (eT) {}
                }
            }
            result.push({
                name:        s.name,
                label:       label,
                kind:        "sequence",
                videoTracks: usedVTracks,
                clips:       totalClips,
                duration:    maxEndTicks > 0 ? (maxEndTicks / TPS) : 0
            });
            seenNames[s.name] = true;
        }

        // 2. MasterClips [TEMPLATE]* na bin (busca recursiva)
        function scanBin(parent, depth) {
            if (depth > 6) return;
            for (var ci = 0; ci < parent.children.numItems; ci++) {
                var child = parent.children[ci];
                var nm = child.name || "";
                if (nm.indexOf("[TEMPLATE]") === 0 && !seenNames[nm]) {
                    // Confirma que não é uma sequence (já foi pego acima)
                    var isSeq = false;
                    try {
                        for (var sq = 0; sq < app.project.sequences.numSequences; sq++) {
                            if (app.project.sequences[sq].name === nm) { isSeq = true; break; }
                        }
                    } catch(eSQ) {}
                    if (!isSeq) {
                        var lbl = nm.replace("[TEMPLATE] ", "").replace("[TEMPLATE]", "")
                                    .replace(/^\s+|\s+$/g, "");
                        result.push({
                            name:        nm,
                            label:       lbl,
                            kind:        "masterclip",
                            videoTracks: 1,
                            clips:       1,
                            duration:    0
                        });
                        seenNames[nm] = true;
                    }
                }
                if (child.children && child.children.numItems > 0) {
                    scanBin(child, depth + 1);
                }
            }
        }
        scanBin(app.project.rootItem, 0);

        return JSON.stringify(result);
    } catch (e) {
        return JSON.stringify({ error: e.message });
    }
}

function getTempFolder() {
    return Folder.temp.fsName;
}

function getProjectPath() {
    try {
        return JSON.stringify({ path: app.project.path || "" });
    } catch(e) {
        return JSON.stringify({ path: "" });
    }
}

// Salva o projeto e retorna o path (para que o cliente possa ler o prproj atualizado)
function saveProjectAndGetPath() {
    try {
        var path = app.project.path || "";
        if (path) {
            try { app.project.save(); } catch(eSave) {}
        }
        return JSON.stringify({ path: path });
    } catch(e) {
        return JSON.stringify({ path: "", error: e.message });
    }
}

// Converte um objeto Time (ou similar) pra segundos, tolerante a versões.
function timeObjToSeconds(t) {
    if (!t) return NaN;
    try { var s = parseFloat(t.seconds); if (!isNaN(s) && s >= 0) return s; } catch (e) {}
    try { var tk = parseFloat(t.ticks); if (!isNaN(tk) && tk > 0) return tk / TICKS_PER_SECOND; } catch (e) {}
    return NaN;
}

// Duração SOURCE do template = (outPoint − inPoint) do projectItem da sequência.
// É EXATAMENTE o que o Premiere insere com overwriteClip (e o que a bin mostra),
// que pode ser MENOR que o maxClipEnd quando a sequência tem In/Out point definido
// (ex: conteúdo interno vai até 15s mas o range In/Out é 5s → insere 5s).
// Retorna 0 se não conseguir medir (cai no fallback maxClipEnd).
function templateSourceDuration(seqName) {
    try {
        var pi = findProjectItem(seqName);
        if (!pi || typeof pi.getOutPoint !== "function") return 0;
        var inP  = timeObjToSeconds(pi.getInPoint());
        var outP = timeObjToSeconds(pi.getOutPoint());
        if (isNaN(inP)) inP = 0;
        if (!isNaN(outP) && outP > inP) return outP - inP;
    } catch (e) {}
    return 0;
}

// Retorna a duração (em segundos) de cada template solicitado.
// Usado pelo JS pra calcular o gap entre PRODUTO e PRECO no auto-fill.
// PRIORIDADE: range In/Out do item (= o que é realmente inserido); só cai pra
// s.end / maxClipEnd se o In/Out não estiver disponível.
function getTemplateDurations(templateNamesJSON) {
    try {
        var names = JSON.parse(templateNamesJSON);
        var result = {};
        var diagnostic = {};
        var content = {}; // maxClipEnd (conteúdo interno) — limite de esticamento
        for (var si = 0; si < app.project.sequences.numSequences; si++) {
            var s = app.project.sequences[si];
            for (var ni = 0; ni < names.length; ni++) {
                var n = names[ni];
                if (s.name === n ||
                    s.name === "[TEMPLATE] " + n ||
                    s.name === "[TEMPLATE]" + n) {

                    var dur = 0;
                    var method = "";

                    // Método 0 (PRIORITÁRIO): range In/Out do item = o que o Premiere
                    // realmente insere. Casa com a bin e com o clip aninhado. Evita o
                    // descasamento "maxClipEnd (conteúdo interno) > duração inserida".
                    try {
                        var srcDur = templateSourceDuration(s.name);
                        if (srcDur > 0) { dur = srcDur; method = "sourceInOut"; }
                    } catch(eSrc) {}

                    // Método 1: s.end.ticks (pode não funcionar em algumas versões)
                    if (!dur) try {
                        if (s.end && s.end.ticks) {
                            var t1 = parseFloat(s.end.ticks);
                            if (t1 > 0) { dur = t1 / TICKS_PER_SECOND; method = "end.ticks"; }
                        }
                    } catch(eE) {}

                    // Método 2: s.end.seconds
                    if (!dur) try {
                        if (s.end && s.end.seconds) {
                            var t2 = parseFloat(s.end.seconds);
                            if (t2 > 0) { dur = t2; method = "end.seconds"; }
                        }
                    } catch(eS) {}

                    // Método 3: itera clips pra achar maior endTime (mais confiável)
                    if (!dur) try {
                        var maxEnd = 0;
                        for (var t = 0; t < s.videoTracks.numTracks; t++) {
                            var tr = s.videoTracks[t];
                            for (var c = 0; c < tr.clips.numItems; c++) {
                                var clp = tr.clips[c];
                                if (clp && clp.end && clp.end.ticks) {
                                    var et = parseFloat(clp.end.ticks);
                                    if (et > maxEnd) maxEnd = et;
                                }
                            }
                        }
                        for (var ta = 0; ta < s.audioTracks.numTracks; ta++) {
                            var tra = s.audioTracks[ta];
                            for (var ca = 0; ca < tra.clips.numItems; ca++) {
                                var clpa = tra.clips[ca];
                                if (clpa && clpa.end && clpa.end.ticks) {
                                    var eta = parseFloat(clpa.end.ticks);
                                    if (eta > maxEnd) maxEnd = eta;
                                }
                            }
                        }
                        if (maxEnd > 0) { dur = maxEnd / TICKS_PER_SECOND; method = "maxClipEnd"; }
                    } catch(eC) {}

                    // Método 4 (último recurso): via QE
                    if (!dur) try {
                        app.enableQE();
                        var prev = app.project.activeSequence;
                        app.project.activeSequence = s;
                        var qeS = qe.project.getActiveSequence();
                        if (qeS && qeS.duration) {
                            var qdur = parseFloat(qeS.duration.secs || qeS.duration.ticks || 0);
                            if (qdur > 0) {
                                // se for ticks, divide
                                dur = qdur > 1000 ? qdur / TICKS_PER_SECOND : qdur;
                                method = "qe.duration";
                            }
                        }
                        try { app.project.activeSequence = prev; } catch(eR) {}
                    } catch(eQ) {}

                    result[n] = dur > 0 ? dur : null;
                    diagnostic[n] = method || "FAILED";
                    try { var cd = templateContentDuration(s.name); if (cd > 0) content[n] = cd; } catch (eCd) {}
                    break;
                }
            }
        }
        return JSON.stringify({ durations: result, methods: diagnostic, contentDurations: content });
    } catch(e) {
        return JSON.stringify({ error: e.message });
    }
}

// Retorna os sequenceIDs das sequências template pelo nome.
// Usado pelo patcher Node.js para saber QUAL GUID Premiere usa para deduplicação
// (Sequence.sequenceID ≠ MasterClip ObjectUID — são campos diferentes no prproj).
function getTemplateSequenceIDs(templateNamesJSON) {
    try {
        var names = JSON.parse(templateNamesJSON);
        var result = {};
        for (var si = 0; si < app.project.sequences.numSequences; si++) {
            var s = app.project.sequences[si];
            for (var ni = 0; ni < names.length; ni++) {
                if (s.name === names[ni]) {
                    result[s.name] = s.sequenceID;
                }
            }
        }
        return JSON.stringify({ ids: result });
    } catch(e) {
        return JSON.stringify({ error: e.message });
    }
}

// Importa um arquivo prproj e retorna os nomes das sequências importadas
function importPrproj(prprojPath) {
    try {
        var bin = getOrCreateBin("Auto Editor - Montagem");
        var beforeCount = app.project.sequences.numSequences;
        var beforeIDs = {};
        var beforeIDList = [];
        for (var bi = 0; bi < app.project.sequences.numSequences; bi++) {
            var sid = app.project.sequences[bi].sequenceID;
            beforeIDs[sid] = true;
            beforeIDList.push(app.project.sequences[bi].name + '=' + sid);
        }
        app.project.importFiles([prprojPath], true, bin, false);
        var afterCount = app.project.sequences.numSequences;
        var newNames = [];
        var afterIDList = [];
        for (var ni = 0; ni < app.project.sequences.numSequences; ni++) {
            var s = app.project.sequences[ni];
            afterIDList.push(s.name + '=' + s.sequenceID);
            if (!beforeIDs[s.sequenceID]) newNames.push(s.name);
        }
        return JSON.stringify({
            success: true,
            sequences: newNames,
            beforeCount: beforeCount,
            afterCount: afterCount,
            beforeIDs: beforeIDList.join('|'),
            afterIDs: afterIDList.join('|')
        });
    } catch(e) {
        return JSON.stringify({ error: e.message });
    }
}

// TESTE: tenta aplicar um preset (.prfpset) ao PRIMEIRO clip da sequência ativa
// por várias APIs diferentes. Retorna diagnóstico de qual método funcionou.
// Usado pra descobrir como aplicar presets em sua versão do Premiere.
function testApplyPreset(presetPath) {
    var diag = { presetPath: presetPath, exists: false, attempts: [] };
    try {
        // Verifica se o arquivo existe
        var f = new File(presetPath);
        diag.exists = f.exists;
        if (!f.exists) {
            diag.error = "Preset não encontrado: " + presetPath;
            return JSON.stringify(diag);
        }

        var seq = app.project.activeSequence;
        if (!seq) {
            diag.error = "Sem sequência ativa";
            return JSON.stringify(diag);
        }

        // Pega o PRIMEIRO clip da primeira track de vídeo que tem clip
        var clip = null;
        var trackIdx = -1, clipIdx = -1;
        for (var t = 0; t < seq.videoTracks.numTracks && !clip; t++) {
            var tr = seq.videoTracks[t];
            if (tr.clips.numItems > 0) {
                clip = tr.clips[0];
                trackIdx = t;
                clipIdx = 0;
                break;
            }
        }
        if (!clip) {
            diag.error = "Nenhum clip encontrado na sequência";
            return JSON.stringify(diag);
        }
        diag.clipName = clip.name || "?";
        diag.clipTrack = trackIdx;

        // ── Método 1: clip.projectItem.applyPreset(path)
        try {
            if (clip.projectItem && typeof clip.projectItem.applyPreset === "function") {
                var r1 = clip.projectItem.applyPreset(presetPath);
                diag.attempts.push("clip.projectItem.applyPreset(path) = " + r1);
            } else {
                diag.attempts.push("clip.projectItem.applyPreset não existe");
            }
        } catch(e1) { diag.attempts.push("clip.projectItem.applyPreset ERR: " + e1.message); }

        // ── Método 2: app.project.importFiles + addEffect
        try {
            var beforeRoot = app.project.rootItem.children.numItems;
            app.project.importFiles([presetPath], false, app.project.rootItem, false);
            var afterRoot = app.project.rootItem.children.numItems;
            diag.attempts.push("importFiles: rootItems " + beforeRoot + " → " + afterRoot);
        } catch(e2) { diag.attempts.push("importFiles ERR: " + e2.message); }

        // ── Método 3: QE clip.applyPreset(path)
        try {
            app.enableQE();
            var qeSeq = qe.project.getActiveSequence();
            if (qeSeq) {
                var qeTrack = qeSeq.getVideoTrackAt(trackIdx);
                var qeClip = qeTrack ? qeTrack.getItemAt(clipIdx) : null;
                if (qeClip) {
                    // Lista métodos disponíveis
                    var qeMethods = [];
                    try { for (var qm in qeClip) { if (typeof qeClip[qm] === "function") qeMethods.push(qm); } } catch(e){}
                    diag.qeClipMethods = qeMethods.slice(0, 25).join(",");

                    // Tenta applyPreset
                    if (typeof qeClip.applyPreset === "function") {
                        try {
                            var r3 = qeClip.applyPreset(presetPath);
                            diag.attempts.push("qeClip.applyPreset(path) = " + r3);
                        } catch(e3) { diag.attempts.push("qeClip.applyPreset(path) ERR: " + e3.message); }
                    } else {
                        diag.attempts.push("qeClip.applyPreset não existe");
                    }

                    // Tenta addPreset
                    if (typeof qeClip.addPreset === "function") {
                        try {
                            var r4 = qeClip.addPreset(presetPath);
                            diag.attempts.push("qeClip.addPreset(path) = " + r4);
                        } catch(e4) { diag.attempts.push("qeClip.addPreset(path) ERR: " + e4.message); }
                    } else {
                        diag.attempts.push("qeClip.addPreset não existe");
                    }

                    // Tenta applyMotionPreset
                    if (typeof qeClip.applyMotionPreset === "function") {
                        try {
                            var r5 = qeClip.applyMotionPreset(presetPath);
                            diag.attempts.push("qeClip.applyMotionPreset(path) = " + r5);
                        } catch(e5) { diag.attempts.push("qeClip.applyMotionPreset ERR: " + e5.message); }
                    }
                } else {
                    diag.attempts.push("qeClip não encontrado");
                }
            }
        } catch(e6) { diag.attempts.push("QE setup ERR: " + e6.message); }

        // ── Método 4: app.project.applyPreset / qeProject.applyPreset
        try {
            if (typeof app.project.applyPreset === "function") {
                var r7 = app.project.applyPreset(presetPath);
                diag.attempts.push("app.project.applyPreset(path) = " + r7);
            } else {
                diag.attempts.push("app.project.applyPreset não existe");
            }
        } catch(e7) { diag.attempts.push("app.project.applyPreset ERR: " + e7.message); }

        // Lista os efeitos do clip APÓS as tentativas pra ver se algum adicionou Transform
        try {
            var afterComps = [];
            for (var ac = 0; ac < clip.components.numItems; ac++) {
                afterComps.push(clip.components[ac].displayName || "?");
            }
            diag.componentsAfter = afterComps.join(", ");
        } catch(eAC) {}

        return JSON.stringify(diag);
    } catch(eOuter) {
        diag.error = eOuter.message;
        return JSON.stringify(diag);
    }
}

// Fecha o projeto atual (sem salvar) e abre um prproj no path dado.
// Usado pela estratégia patch+reload: o JS patcha o prproj no disco com o texto
// novo dentro dos blobs binários de 348 bytes (preservando TextDocument), e aqui
// forçamos o Premiere a recarregar o arquivo para que as mudanças entrem em memória.
function closeAndReopenProject(prprojPath) {
    try {
        if (app.project) {
            // closeDocument(saveChanges, promptUser) — 0,0 = não salva, não pergunta
            try { app.project.closeDocument(0, 0); }
            catch(eC) {
                try { app.project.closeDocument(); } catch(eC2) {}
            }
        }
        // openDocument é síncrono — bloqueia até o projeto carregar
        var ok = app.openDocument(prprojPath);
        return JSON.stringify({
            ok: ok ? true : false,
            hasProject: app.project ? true : false,
            name: app.project ? app.project.name : null,
            seqCount: app.project ? app.project.sequences.numSequences : 0
        });
    } catch(e) {
        return JSON.stringify({ error: e.message });
    }
}

// Clona uma template e renomeia para newName. Salva o projeto após clone.
// Pré-condição: o prproj em disco já foi patchado com o texto do produto, e
// closeAndReopenProject foi chamado para recarregar. Então o template em memória
// tem o TextDocument com texto novo; clone() preserva isso na cópia.
function cloneTemplateForProduct(templateName, newName) {
    try {
        var templateSeq = findTemplateSequence(templateName);
        if (!templateSeq) {
            return JSON.stringify({ error: "Template não encontrado: " + templateName });
        }

        // Se já existe (clone anterior), retorna ok sem refazer
        for (var i = 0; i < app.project.sequences.numSequences; i++) {
            if (app.project.sequences[i].name === newName) {
                return JSON.stringify({ ok: true, sequence: newName, existed: true });
            }
        }

        var logArr = [];
        var copiedSeq = createProductSequenceCopy(templateSeq, newName, logArr);
        if (!copiedSeq) {
            return JSON.stringify({ error: "clone falhou: " + logArr.join('; '), log: logArr });
        }

        // Salva o projeto para persistir o clone em disco (importante: o JS pode
        // reler o prproj depois para mais patching, e quer ver o clone lá).
        try { app.project.save(); } catch(eS) {}

        return JSON.stringify({ ok: true, sequence: newName, log: logArr });
    } catch(e) {
        return JSON.stringify({ error: e.message });
    }
}

// Lê um arquivo local e retorna o conteúdo como string
function readFileContent(filePath, encoding) {
    try {
        var f = new File(filePath);
        if (!f.exists) return JSON.stringify({ error: "Arquivo não encontrado" });
        f.encoding = encoding || "UTF-8";
        f.open("r");
        var content = f.read();
        f.close();
        return JSON.stringify({ content: content });
    } catch(e) {
        return JSON.stringify({ error: e.message });
    }
}

// Abre diálogo nativo de seleção de pasta
function selectFolder() {
    try {
        var folder = Folder.selectDialog("Selecione a pasta raiz do vídeo");
        if (!folder) return JSON.stringify({ cancelled: true });
        return JSON.stringify({ path: folder.fsName });
    } catch (e) {
        return JSON.stringify({ error: e.message });
    }
}

// Busca um ProjectItem pelo nome em todo o projeto (recursivo)
function findProjectItem(name) {
    function search(parent) {
        for (var i = 0; i < parent.children.numItems; i++) {
            var child = parent.children[i];
            if (child.name === name) return child;
            if (child.children && child.children.numItems > 0) {
                var found = search(child);
                if (found) return found;
            }
        }
        return null;
    }
    return search(app.project.rootItem);
}

// Procura projectItem pelo CAMINHO completo (não apenas pelo nome).
// Necessário porque vários arquivos podem ter o mesmo nome (ex: 1/png.png e 2/png.png)
// — comparar só por nome retornaria sempre o primeiro importado.
function findProjectItemByPath(targetPath) {
    var target = String(targetPath || "").replace(/\\/g, "/").toLowerCase();
    if (!target) return null;
    function search(parent) {
        for (var i = 0; i < parent.children.numItems; i++) {
            var child = parent.children[i];
            try {
                var mp = "";
                // getMediaPath() é o caminho real do arquivo de mídia
                if (typeof child.getMediaPath === "function") {
                    mp = child.getMediaPath() || "";
                }
                if (mp) {
                    var mpNorm = String(mp).replace(/\\/g, "/").toLowerCase();
                    if (mpNorm === target) return child;
                }
            } catch(e) {}
            if (child.children && child.children.numItems > 0) {
                var found = search(child);
                if (found) return found;
            }
        }
        return null;
    }
    return search(app.project.rootItem);
}

// Importa um arquivo e retorna o ProjectItem (evita duplicatas)
// Retorna null silenciosamente se o arquivo não existir (sem popup do Premiere)
function importAndGet(filePath) {
    // Verifica existência antes de tentar importar para evitar o popup nativo
    try {
        var f = new File(filePath);
        if (!f.exists) return null;
    } catch(e) { return null; }

    // Procura por CAMINHO completo (não apenas pelo nome) — assim 1/png.png e 2/png.png
    // são tratados como itens diferentes mesmo tendo o mesmo nome de arquivo.
    var existing = findProjectItemByPath(filePath);
    if (existing) return existing;

    app.project.importFiles([filePath], true, app.project.rootItem, false);
    return findProjectItemByPath(filePath);
}

// Garante que a faixa de vídeo no índice existe.
// PPro 2024+ não tem mais videoTracks.addTrack() — usa QE API como fallback.
function ensureVideoTrack(seq, trackIndex) {
    while (seq.videoTracks.numTracks <= trackIndex) {
        var added = false;

        // Tentativa 1: API moderna (DOM)
        try {
            if (typeof seq.videoTracks.addTrack === "function") {
                seq.videoTracks.addTrack();
                added = true;
            }
        } catch (eA) {}

        // Tentativa 2: QE API (sempre disponível, mas requer enableQE)
        if (!added) {
            try {
                if (typeof app.enableQE === "function") app.enableQE();
                // QE só opera sobre a sequência ATIVA — força ativação temporária.
                var prevActive = app.project.activeSequence;
                var needRestore = false;
                if (prevActive !== seq) {
                    try { app.project.activeSequence = seq; needRestore = true; } catch(eAct) {}
                }
                var qeSeq = qe.project.getActiveSequence();
                if (qeSeq && typeof qeSeq.addTracks === "function") {
                    // signature: addTracks(numVideo, videoIndex, numAudio, audioType, audioIndex, ...)
                    // Adiciona 1 track de vídeo no final, 0 áudios.
                    var curN = seq.videoTracks.numTracks;
                    qeSeq.addTracks(1, curN, 0, 1, 0, 0, 0);
                    added = true;
                }
                if (needRestore) {
                    try { app.project.activeSequence = prevActive; } catch(eRest) {}
                }
            } catch (eB) {}
        }

        if (!added) {
            throw new Error("Não consegui adicionar track de vídeo " + (trackIndex + 1) +
                " (PPro " + (app.version || "?") + "). Crie manualmente a track " + (trackIndex + 1) +
                " na sequência principal e tente novamente.");
        }
    }
    return seq.videoTracks[trackIndex];
}

// Garante que a faixa de ÁUDIO no índice existe (QE fallback, igual vídeo).
function ensureAudioTrack(seq, trackIndex) {
    while (seq.audioTracks.numTracks <= trackIndex) {
        var added = false;
        try {
            if (typeof seq.audioTracks.addTrack === "function") {
                seq.audioTracks.addTrack();
                added = true;
            }
        } catch (eA) {}
        if (!added) {
            try {
                if (typeof app.enableQE === "function") app.enableQE();
                var prevActive = app.project.activeSequence;
                var needRestore = false;
                if (prevActive !== seq) {
                    try { app.project.activeSequence = seq; needRestore = true; } catch(eAct) {}
                }
                var qeSeq = qe.project.getActiveSequence();
                if (qeSeq && typeof qeSeq.addTracks === "function") {
                    // addTracks(numVideo, videoIndex, numAudio, audioType, audioIndex, ...)
                    // 0 vídeos, 1 áudio (tipo 1 = stereo) no final.
                    var curN = seq.audioTracks.numTracks;
                    qeSeq.addTracks(0, 0, 1, 1, curN, 0, 0);
                    added = true;
                }
                if (needRestore) {
                    try { app.project.activeSequence = prevActive; } catch(eRest) {}
                }
            } catch (eB) {}
        }
        if (!added) {
            throw new Error("Não consegui adicionar track de áudio " + (trackIndex + 1) +
                " (PPro " + (app.version || "?") + ").");
        }
    }
    return seq.audioTracks[trackIndex];
}

// Índice da track de SFX dedicada (resolvido 1x por mount, reusado por todas
// as transições). Reset em mountFromJSON.
var _sfxAudioTrackIdx = -1;

// ──────────────────────────────────────────────────────────────────────
// Helpers de cópia de efeitos (usados pra transições de adjustment layer
// tipo Premiere Composer, que não têm projectItem). Copia componentes +
// keyframes de um trackItem fonte pra um trackItem destino.
// ──────────────────────────────────────────────────────────────────────

// Procura na bin um projectItem que seja Adjustment Layer (por nome).
function findAdjustmentLayerItem() {
    var found = null;
    function scan(item, depth) {
        if (found || depth > 8) return;
        try {
            for (var i = 0; i < item.children.numItems; i++) {
                var ch = item.children[i];
                var nm = "";
                try { nm = ch.name || ""; } catch(e) {}
                // Adjustment Layer em qualquer idioma costuma conter "Adjustment"
                // ou "Camada de Ajuste" (pt). Match flexível.
                if (nm && (nm.indexOf("Adjustment") >= 0 ||
                           nm.indexOf("Ajuste") >= 0 ||
                           nm.toLowerCase().indexOf("adjustment layer") >= 0)) {
                    found = ch; return;
                }
                try { if (ch.children && ch.children.numItems > 0) scan(ch, depth+1); } catch(e) {}
            }
        } catch(e) {}
    }
    try { scan(app.project.rootItem, 0); } catch(e) {}
    return found;
}

// Diagnóstico de interpolação (preenchido por _fxCopyProp, lido por copyAllEffects)
var _fxInterpDiag = [];

// Converte um elemento de getKeys() pra número (segundos ou ticks, conforme
// o formato nativo). Retorna { num, isTime }.
function _fxKeyNum(k) {
    if (typeof k === "number") return { num: k, isTime: false };
    try { if (k && k.ticks !== undefined) return { num: parseFloat(k.ticks), isTime: true }; } catch(e) {}
    try { if (k && k.seconds !== undefined) return { num: parseFloat(k.seconds), isTime: false }; } catch(e) {}
    return { num: parseFloat(k), isTime: false };
}

// Copia uma property (valor estático OU keyframes) src→tgt.
// Pra props animadas, BAKEIA a curva: amostra o valor em ~N pontos ao longo
// da animação (via getValueAtTime) e cria keyframes lineares densos. Isso
// reproduz a curva EXATA (qualquer ease/handle), já que a API não expõe nem
// leitura do tipo de interpolação nem das alças do bezier.
// Fallback (sem getValueAtTime): copia os keyframes originais + seta Bezier.
function _fxCopyProp(srcProp, tgtProp) {
    if (!srcProp || !tgtProp) return false;
    var isTV = false;
    try { isTV = srcProp.isTimeVarying(); } catch(e) {}
    if (!isTV) {
        try { tgtProp.setValue(srcProp.getValue(), true); return true; } catch(e) { return false; }
    }

    try { tgtProp.setTimeVarying(true); } catch(e) {}
    // limpa keys antigos do tgt
    try {
        var old = tgtProp.getKeys();
        if (old) for (var k = old.length - 1; k >= 0; k--) { try { tgtProp.removeKey(old[k]); } catch(e) {} }
    } catch(e) {}

    var keys;
    try { keys = srcProp.getKeys(); } catch(e) { keys = null; }
    if (!keys || !keys.length) {
        try { tgtProp.setValue(srcProp.getValue(), true); } catch(e) {}
        return true;
    }

    var pName = ""; try { pName = srcProp.displayName; } catch(e) {}
    var hasGVT = false;
    try { hasGVT = (typeof srcProp.getValueAtTime === "function"); } catch(e) {}

    // ── BAKE: amostra a curva em N pontos densos ──────────────────────────
    if (hasGVT) {
        var k0 = _fxKeyNum(keys[0]);
        var kN = _fxKeyNum(keys[keys.length - 1]);
        var first = k0.num, last = kN.num, isTime = k0.isTime;
        var range = last - first;
        if (range > 0) {
            var N = 30; // pontos de amostragem (denso o suficiente p/ 0.3-1s)
            var step = range / N;
            var baked = 0;
            var sampleDiag = [];
            for (var s = 0; s <= N; s++) {
                var tnum = first + step * s;
                // monta o "tempo" no mesmo formato dos keys (Time ou número)
                var tArg;
                if (isTime) { tArg = new Time(); tArg.ticks = String(tnum); }
                else { tArg = tnum; }
                try {
                    var sv = srcProp.getValueAtTime(tArg);
                    tgtProp.addKey(tArg);
                    tgtProp.setValueAtKey(tArg, sv, true);
                    baked++;
                    if (s < 3) sampleDiag.push(String(sv));
                } catch(eB) {}
            }
            _fxInterpDiag.push("bake '" + pName + "': isTime=" + isTime +
                " range=" + range.toFixed(3) + " baked=" + baked + "/" + (N+1) +
                " primeiros=[" + sampleDiag.join(" | ") + "]");
            if (baked > 0) return true;
        }
    }

    // ── FALLBACK: copia keys originais + tenta setar Bezier ───────────────
    var n = 0;
    for (var ki = 0; ki < keys.length; ki++) {
        try {
            var v = srcProp.getValueAtKey(keys[ki]);
            tgtProp.addKey(keys[ki]);
            tgtProp.setValueAtKey(keys[ki], v, true);
            n++;
        } catch(e) {}
    }
    var hasSetter = false;
    try { hasSetter = (typeof tgtProp.setInterpolationTypeAtKey === "function"); } catch(e) {}
    _fxInterpDiag.push("fallback '" + pName + "': sem getValueAtTime, " + n + " keys + bezier");
    if (hasSetter) {
        for (var kj = 0; kj < keys.length; kj++) {
            try { tgtProp.setInterpolationTypeAtKey(keys[kj], 2, true); } catch(e) {}
        }
    }
    return n > 0;
}

// Copia todas as properties de srcComp→tgtComp casando ESTRITAMENTE por
// displayName (com índice de ocorrência pra props de mesmo nome). NÃO usa
// match por índice posicional — isso causava troca de keyframes entre props
// quando a ordem das properties diferia entre src e dst.
function _fxCopyCompProps(srcComp, tgtComp) {
    var sp, tp;
    try { sp = srcComp.properties; } catch(e) { return 0; }
    try { tp = tgtComp.properties; } catch(e) { return 0; }
    if (!sp || !tp) return 0;
    var n = 0;
    var occUsed = {}; // displayName -> nº de ocorrências já consumidas no dst
    for (var i = 0; i < sp.numItems; i++) {
        var s = null;
        try { s = sp[i]; } catch(e) { continue; }
        if (!s) continue;
        var sName = ""; try { sName = s.displayName; } catch(e) {}
        if (!sName) continue;
        var occ = occUsed[sName] || 0;
        occUsed[sName] = occ + 1;
        // acha a occ-ésima property do dst com esse displayName
        var t = null, seen = 0;
        for (var j = 0; j < tp.numItems; j++) {
            try {
                if (tp[j].displayName === sName) {
                    if (seen === occ) { t = tp[j]; break; }
                    seen++;
                }
            } catch(e) {}
        }
        if (!t) continue;
        if (_fxCopyProp(s, t)) n++;
    }
    return n;
}

// Acha a N-ésima (0-based) ocorrência de um componente por displayName.
// displayName é estável entre src e dst (matchName às vezes difere, ex Transform).
function _fxFindCompByNameNth(comps, displayName, nth) {
    if (!displayName) return null;
    var seen = 0;
    for (var i = 0; i < comps.numItems; i++) {
        try {
            if (comps[i].displayName === displayName) {
                if (seen === nth) return comps[i];
                seen++;
            }
        } catch(e) {}
    }
    return null;
}

// Acha componente por matchName.
function _fxFindComp(comps, matchName) {
    if (!matchName) return null;
    for (var i = 0; i < comps.numItems; i++) {
        try { if (comps[i].matchName === matchName) return comps[i]; } catch(e) {}
    }
    return null;
}

// Acha a N-ésima (0-based) ocorrência de um componente por matchName.
// Necessário quando há múltiplas instâncias do mesmo efeito (ex: Mirror×4).
function _fxFindCompNth(comps, matchName, nth) {
    if (!matchName) return null;
    var seen = 0;
    for (var i = 0; i < comps.numItems; i++) {
        try {
            if (comps[i].matchName === matchName) {
                if (seen === nth) return comps[i];
                seen++;
            }
        } catch(e) {}
    }
    return null;
}

// Conta quantos componentes de um matchName existem.
function _fxCountComp(comps, matchName) {
    var n = 0;
    for (var i = 0; i < comps.numItems; i++) {
        try { if (comps[i].matchName === matchName) n++; } catch(e) {}
    }
    return n;
}

// Adiciona efeito via QE a um trackItem (precisa mainSeq ativa).
// QE.addVideoEffect espera um OBJETO de efeito (de qe.project.getVideoEffectByName),
// não uma string. displayName = nome visível ("Mirror", "Transform", etc).
// dstTrackIdx (0-based): se fornecido, busca SÓ nessa track (desambigua clips
// de mesmo nome/start em tracks diferentes).
function _fxAddEffectQE(targetClip, matchName, displayName, mainSeq, dstTrackIdx) {
    try {
        if (!app.enableQE) return false;
        app.enableQE();
        if (typeof qe === "undefined" || !qe) return false;
        var qeSeq = qe.project.getActiveSequence();
        if (!qeSeq) return false;

        // Resolve o objeto de efeito pelo nome visível
        var fxObj = null;
        try { fxObj = qe.project.getVideoEffectByName(displayName); } catch(e) {}
        if (!fxObj) {
            // fallback: tenta pelo matchName direto (algumas versões aceitam)
            try { fxObj = qe.project.getVideoEffectByName(matchName); } catch(e) {}
        }
        if (!fxObj) return false;

        var ts = 0; try { ts = parseFloat(targetClip.start.ticks); } catch(e) {}
        var tname = ""; try { tname = targetClip.name; } catch(e) {}

        var trackStart = 0, trackEnd = qeSeq.numVideoTracks;
        if (dstTrackIdx !== undefined && dstTrackIdx !== null &&
            dstTrackIdx >= 0 && dstTrackIdx < qeSeq.numVideoTracks) {
            trackStart = dstTrackIdx; trackEnd = dstTrackIdx + 1;
        }
        for (var tt = trackStart; tt < trackEnd; tt++) {
            var qt = qeSeq.getVideoTrackAt(tt);
            for (var cc = 0; cc < qt.numItems; cc++) {
                var qc = qt.getItemAt(cc);
                try {
                    var qs = 0; try { qs = parseFloat(qc.start.ticks); } catch(e) {}
                    if (qc.name === tname && Math.abs(qs - ts) < 100000000) {
                        qc.addVideoEffect(fxObj);
                        return true;
                    }
                } catch(e) {}
            }
        }
    } catch(e) {}
    return false;
}

// Copia TODOS os efeitos (componentes não-intrínsecos) + valores de src→dst.
// DUAS PASSADAS pra ser robusto à posição em que addVideoEffect insere o efeito:
//   PASSADA 1: adiciona via QE todos os efeitos não-intrínsecos (em ordem do src)
//   PASSADA 2: re-lê o dst e casa src↔dst por DISPLAY NAME + índice de ocorrência
//              (displayName é estável; matchName às vezes muda quando adicionado),
//              depois copia as properties (também casadas por displayName).
// Retorna { comps, added }.
function copyAllEffects(srcClip, dstClip, mainSeq, logArr, dstTrackIdx) {
    var srcComps;
    try { srcComps = srcClip.components; } catch(e) { return { comps: 0, added: 0 }; }
    _fxInterpDiag = []; // limpa diag de interpolação

    // Classifica cada componente do src
    function classify(sc) {
        var mn = "", dn = "";
        try { mn = sc.matchName; } catch(e) {}
        try { dn = sc.displayName; } catch(e) {}
        var isIntrinsic = (mn === "AE.ADBE Motion" || mn === "AE.ADBE Opacity" ||
                           mn.indexOf("ADBE Time") >= 0);
        var isContent = (mn.indexOf("Text") >= 0 || mn.indexOf("Shape") >= 0 ||
                         mn.indexOf("Type") >= 0 ||
                         mn.indexOf("Graphic Group") >= 0 ||
                         dn === "Vector Motion");
        return { mn: mn, dn: dn, intrinsic: isIntrinsic, content: isContent };
    }

    // ── PASSADA 1: adiciona efeitos não-intrínsecos via QE (ordem do src) ──
    var nAdded = 0;
    for (var i = 0; i < srcComps.numItems; i++) {
        var sc1 = null;
        try { sc1 = srcComps[i]; } catch(e) { continue; }
        if (!sc1) continue;
        var c1 = classify(sc1);
        if (!c1.mn || c1.intrinsic || c1.content) continue;
        if (_fxAddEffectQE(dstClip, c1.mn, c1.dn, mainSeq, dstTrackIdx)) {
            nAdded++;
        } else if (logArr) {
            logArr.push("    fx skip '" + c1.dn + "' (" + c1.mn + "): não adicionou via QE");
        }
    }

    // ── PASSADA 2: casa por displayName+ocorrência e copia properties ──────
    var dstComps;
    try { dstComps = dstClip.components; } catch(e) { return { comps: 0, added: nAdded }; }

    var nComps = 0;
    var occUsed = {}; // displayName -> ocorrências já consumidas no src
    for (var k = 0; k < srcComps.numItems; k++) {
        var sc2 = null;
        try { sc2 = srcComps[k]; } catch(e) { continue; }
        if (!sc2) continue;
        var c2 = classify(sc2);
        if (!c2.dn || c2.content) continue;

        var occ = occUsed[c2.dn] || 0;
        occUsed[c2.dn] = occ + 1;

        var dc = _fxFindCompByNameNth(dstComps, c2.dn, occ);
        if (!dc) {
            if (logArr && !c2.intrinsic) logArr.push("    fx skip '" + c2.dn + "' #" + occ + ": sem correspondente no dst");
            continue;
        }
        var np = _fxCopyCompProps(sc2, dc);
        if (np > 0) nComps++;
    }
    return { comps: nComps, added: nAdded };
}

// Expande o conteúdo de uma sequência diretamente na timeline principal,
// ao invés de inseri-la como sequência aninhada. Preserva o range (inPoint/
// outPoint) e cascateia as tracks: srcSeq.V1 → mainSeq.V[baseTrack],
// srcSeq.V2 → mainSeq.V[baseTrack+1], etc.
//
// Esse modo é necessário pra MOGRTs (Premiere Composer etc) cujas animações
// de entrada/saída dependem da duração do clip no timeline — quando aninhado,
// trimar a sequência aninhada apenas corta a visualização, sem recalcular as
// animações do MOGRT interno.
//
// Retorna { ok, inserted, tracksUsed, clipPairs[], log[] }
//   clipPairs: array de {src, dst} — clip original do template + clip novo na
//   main. O caller usa pra ler valores estilizados do src (TextDocument com
//   [[INFO]]) e escrever no dst após substituição, preservando fonte/cor.
// anchorMode:
//   null / "start" → comportamento padrão: clips começam em baseTimeSec
//   "cut"          → detecta o CORTE INTERNO do template (junção entre 2 clips
//                    adjacentes) e alinha ESSE ponto com baseTimeSec. Usado pra
//                    transições (Premiere Composer etc) que precisam ficar
//                    centradas sobre um corte — o ponto onde os 2 adjustment
//                    layers se encontram cai exatamente no timestamp resolvido.
function expandSequenceIntoMain(srcSeq, mainSeq, baseTrackIndex, baseTimeSec, anchorMode) {
    var TPS = 254016000000;
    var log = [];
    var inserted   = 0;
    var maxTrackUsed = baseTrackIndex;
    var clipPairs = [];

    // Encontra menor track ocupada da source pra usar como offset
    var srcMinTrack = -1;
    for (var t = 0; t < srcSeq.videoTracks.numTracks; t++) {
        if (srcSeq.videoTracks[t].clips.numItems > 0) { srcMinTrack = t; break; }
    }
    if (srcMinTrack < 0) {
        return { ok: false, inserted: 0, tracksUsed: 0, log: ["src seq sem clips"] };
    }

    // ── Detecta âncora (corte interno) se anchorMode === "cut" ────────────
    // Procura, em todas as tracks, a junção entre 2 clips adjacentes
    // (end do clip[i] ≈ start do clip[i+1]). Usa a junção mais comum como
    // ponto de ancoragem. Se não achar, anchor = 0 (= comportamento padrão).
    var anchorTicks = 0;
    if (anchorMode === "cut") {
        var boundaries = [];
        for (var at = srcMinTrack; at < srcSeq.videoTracks.numTracks; at++) {
            var atrack = srcSeq.videoTracks[at];
            if (atrack.clips.numItems < 2) continue;
            for (var ac = 0; ac < atrack.clips.numItems - 1; ac++) {
                var endT = 0, nextStartT = 0;
                try { endT = parseFloat(atrack.clips[ac].end.ticks); } catch(e) {}
                try { nextStartT = parseFloat(atrack.clips[ac + 1].start.ticks); } catch(e) {}
                // junção = clips se tocam (gap < 0.1s) ou overlap pequeno
                if (Math.abs(endT - nextStartT) < TPS * 0.1) {
                    boundaries.push((endT + nextStartT) / 2);
                }
            }
        }
        if (boundaries.length > 0) {
            // Usa a mediana das junções detectadas (robusto a outliers)
            boundaries.sort(function(a, b) { return a - b; });
            anchorTicks = boundaries[Math.floor(boundaries.length / 2)];
            log.push("anchor='cut': junção interna @ " + (anchorTicks / TPS).toFixed(3) + "s (" + boundaries.length + " detectada(s))");
        } else {
            log.push("anchor='cut': nenhuma junção interna achada — usando início (anchor=0)");
        }
    } else if (anchorMode === "marker") {
        // Lê o marcador que define o ponto que deve cair no timestamp resolvido.
        // Procura em 2 lugares (o marcador pode estar em qualquer um):
        //   1. Marcador de SEQUÊNCIA (na régua da timeline do template)
        //   2. Marcador de CLIP (no projectItem do adjustment layer) — convertido
        //      pro tempo da sequência: clipStart + (mkMediaTime − clipInPoint)
        var anchorFound = false;

        // 1. Sequência
        try {
            var smk = srcSeq.markers.getFirstMarker();
            if (smk) {
                anchorTicks = parseFloat(smk.start.ticks);
                log.push("anchor='marker': marcador de SEQUÊNCIA @ " + (anchorTicks / TPS).toFixed(3) + "s");
                anchorFound = true;
            }
        } catch(e) {}

        // 2. Clip (projectItem)
        if (!anchorFound) {
            for (var mt = srcMinTrack; mt < srcSeq.videoTracks.numTracks && !anchorFound; mt++) {
                var mtr = srcSeq.videoTracks[mt];
                for (var mc = 0; mc < mtr.clips.numItems && !anchorFound; mc++) {
                    var mclip = mtr.clips[mc];
                    var mpit = null;
                    try { mpit = mclip.projectItem; } catch(e) {}
                    if (!mpit) continue;
                    var cmk = null;
                    try { cmk = mpit.getMarkers().getFirstMarker(); } catch(e) {}
                    if (cmk) {
                        var mkMedia = 0, cStart = 0, cIn = 0;
                        try { mkMedia = parseFloat(cmk.start.ticks); } catch(e) {}
                        try { cStart  = parseFloat(mclip.start.ticks); } catch(e) {}
                        try { cIn     = parseFloat(mclip.inPoint.ticks); } catch(e) {}
                        anchorTicks = cStart + (mkMedia - cIn);
                        log.push("anchor='marker': marcador de CLIP @ seqTime " + (anchorTicks / TPS).toFixed(3) +
                                 "s (clipStart=" + (cStart/TPS).toFixed(3) + " mkMedia=" + (mkMedia/TPS).toFixed(3) +
                                 " clipIn=" + (cIn/TPS).toFixed(3) + ")");
                        anchorFound = true;
                    }
                }
            }
        }

        if (!anchorFound) {
            log.push("anchor='marker': NENHUM marcador (sequência nem clip) — usando início (anchor=0). Adicione um marcador no ponto do corte.");
        }
    }

    // Adjustment Layer base da bin (pra recriar clips de transição tipo
    // Premiere Composer que são adjustment layers sem projectItem).
    var adjLayerItem = findAdjustmentLayerItem();
    if (adjLayerItem) log.push("Adjustment Layer base: '" + adjLayerItem.name + "' (pra transições)");

    for (var st = srcMinTrack; st < srcSeq.videoTracks.numTracks; st++) {
        var srcTrack = srcSeq.videoTracks[st];
        if (srcTrack.clips.numItems === 0) continue;

        var dstTrackIdx = baseTrackIndex + (st - srcMinTrack);
        var dstTrack;
        try {
            dstTrack = ensureVideoTrack(mainSeq, dstTrackIdx);
        } catch (eET) {
            log.push("V" + (st+1) + " → V" + (dstTrackIdx+1) + " ensureTrack ERR: " + eET.message);
            continue;
        }
        if (dstTrackIdx > maxTrackUsed) maxTrackUsed = dstTrackIdx;

        for (var c = 0; c < srcTrack.clips.numItems; c++) {
            var srcClip = srcTrack.clips[c];

            // Calcula tempo destino: baseTime + offset do clip dentro da source seq
            var srcStartTicks = 0;
            try { srcStartTicks = parseFloat(srcClip.start.ticks); } catch (eS) {}
            var srcEndTicks = 0;
            try { srcEndTicks = parseFloat(srcClip.end.ticks); } catch (eE) {}
            var srcInPtTicks  = 0;
            var srcOutPtTicks = 0;
            try { srcInPtTicks  = parseFloat(srcClip.inPoint.ticks);  } catch (eIn) {}
            try { srcOutPtTicks = parseFloat(srcClip.outPoint.ticks); } catch (eOut) {}

            // Subtrai anchorTicks pra alinhar o corte interno (não o início)
            // com baseTimeSec. anchorTicks=0 → comportamento padrão.
            var dstTimeTicks = (baseTimeSec * TPS) + srcStartTicks - anchorTicks;
            if (dstTimeTicks < 0) dstTimeTicks = 0; // não deixa ir pra antes do início da timeline

            // projectItem é o MasterClip da bin. overwriteClip aceita esse item.
            var pi = null;
            var piErr = "";
            try { pi = srcClip.projectItem; } catch (ePI) { piErr = ePI.message; }

            // ── CASO ADJUSTMENT LAYER (transições) ────────────────────────────
            // Adjustment layer (com ou sem projectItem). Insere um adjustment
            // layer base + copia TODOS os efeitos (Transform/Mirror/Lens Distortion
            // + keyframes). Importante mesmo quando pi != null, porque os efeitos
            // vivem na INSTÂNCIA da timeline (não no item da bin), então
            // overwriteClip(pi) sozinho insere um adj layer VAZIO.
            var isAdj = false;
            try { isAdj = srcClip.isAdjustmentLayer(); } catch(e) {}
            if (isAdj) {
                // Base pra inserir: o próprio projectItem (se for adj layer) ou
                // um Adjustment Layer qualquer da bin.
                var baseAdjItem = adjLayerItem;
                if (pi) {
                    var piIsAdj = false;
                    try { piIsAdj = (pi.name && pi.name.indexOf("Adjustment") >= 0); } catch(e) {}
                    // Usa pi como base (instância nova herda só os defaults da bin = vazio)
                    baseAdjItem = pi;
                }
                if (!baseAdjItem) {
                    log.push("V" + (st+1) + " clip " + c + ": adjustment layer mas NENHUM 'Adjustment Layer' na bin — crie um (Project > New Item > Adjustment Layer)");
                    continue;
                }
                try {
                    var adjDur = srcEndTicks - srcStartTicks;
                    var adjStart = new Time(); adjStart.ticks = String(dstTimeTicks);
                    dstTrack.overwriteClip(baseAdjItem, adjStart);
                    // Acha o clip recém-inserido
                    var newAdj = null;
                    for (var na = dstTrack.clips.numItems - 1; na >= 0; na--) {
                        var ca = dstTrack.clips[na];
                        var cas = 0; try { cas = parseFloat(ca.start.ticks); } catch(e) {}
                        if (Math.abs(cas - dstTimeTicks) < TPS) { newAdj = ca; break; }
                    }
                    if (newAdj) {
                        // Ajusta duração pra bater com o clip fonte
                        try {
                            var adjEnd = new Time(); adjEnd.ticks = String(dstTimeTicks + adjDur);
                            newAdj.end = adjEnd;
                        } catch(eAE) {}
                        // QE addVideoEffect precisa da main seq ativa
                        try { app.project.activeSequence = mainSeq; } catch(eSA) {}
                        var fxRes = copyAllEffects(srcClip, newAdj, mainSeq, log, dstTrackIdx);
                        inserted++;
                        log.push("V" + (st+1) + " clip " + c + " (adjLayer): " + fxRes.comps + " efeito(s) copiado(s), " + fxRes.added + " adicionado(s) via QE");
                        // DIAG interpolação (só do primeiro clip pra não poluir)
                        if (c === 0) {
                            for (var di = 0; di < _fxInterpDiag.length; di++) {
                                log.push("  " + _fxInterpDiag[di]);
                            }
                        }
                    } else {
                        log.push("V" + (st+1) + " clip " + c + " (adjLayer): inseriu mas não localizou o clip novo");
                    }
                } catch(eAdj) {
                    log.push("V" + (st+1) + " clip " + c + " (adjLayer) ERR: " + eAdj.message);
                }
                continue;
            }

            if (!pi) {
                log.push("V" + (st+1) + " clip " + c + " SKIP — sem projectItem" +
                    (piErr ? " (THREW: " + piErr + ")" : "") +
                    (isAdj ? " [adjLayer mas sem base]" : ""));
                continue;
            }
            var dstTime = new Time();
            dstTime.ticks = String(dstTimeTicks);

            try {
                dstTrack.overwriteClip(pi, dstTime);
                inserted++;

                // Encontra o clip recém-inserido (start ~= dstTimeTicks).
                // Faz isso SEMPRE (não só quando inPoint > 0) porque precisamos
                // retornar a referência pro caller aplicar text substitutions.
                var newClip = null;
                for (var nc = dstTrack.clips.numItems - 1; nc >= 0; nc--) {
                    var cand = dstTrack.clips[nc];
                    var cStart = 0;
                    try { cStart = parseFloat(cand.start.ticks); } catch(eCS) {}
                    if (Math.abs(cStart - dstTimeTicks) < TPS) { // tolerância 1s
                        newClip = cand; break;
                    }
                }
                if (newClip) {
                    clipPairs.push({ src: srcClip, dst: newClip });
                    // Ajusta in/out point do clip recém-inserido pra match source.
                    // overwriteClip insere o range completo do MasterClip; precisamos
                    // restringir pro mesmo range que a source seq tinha.
                    if (srcInPtTicks > 0 || srcOutPtTicks > 0) {
                        try {
                            var newIn = new Time(); newIn.ticks = String(srcInPtTicks);
                            newClip.inPoint = newIn;
                        } catch (eSetIn) {}
                        try {
                            var newOut = new Time(); newOut.ticks = String(srcOutPtTicks);
                            newClip.outPoint = newOut;
                        } catch (eSetOut) {}
                    }
                }
            } catch (eOver) {
                log.push("V" + (st+1) + " clip " + c + " overwriteClip ERR: " + eOver.message);
            }
        }

        log.push("V" + (st+1) + " → V" + (dstTrackIdx+1) + ": " + srcTrack.clips.numItems + " clip(s)");
    }

    // ── ÁUDIO: insere SFX da template numa track dedicada ─────────────────
    // Todos os clips de áudio da sequência template vão pra UMA track de SFX
    // na main (resolvida 1x por mount em _sfxAudioTrackIdx e reusada), com o
    // mesmo offset de âncora do marcador → SFX sincronizado com a transição.
    var audioInserted = 0;
    try {
        var hasAudio = false;
        for (var atk = 0; atk < srcSeq.audioTracks.numTracks; atk++) {
            if (srcSeq.audioTracks[atk].clips.numItems > 0) { hasAudio = true; break; }
        }
        if (hasAudio) {
            // Resolve a track de SFX uma vez (cria uma nova no final da main)
            if (_sfxAudioTrackIdx < 0) {
                _sfxAudioTrackIdx = mainSeq.audioTracks.numTracks; // nova track no fim
            }
            var sfxTrack = null;
            try { sfxTrack = ensureAudioTrack(mainSeq, _sfxAudioTrackIdx); } catch(eSfxT) {
                log.push("SFX: falha ao garantir track de áudio: " + eSfxT.message);
            }
            if (sfxTrack) {
                for (var sat = 0; sat < srcSeq.audioTracks.numTracks; sat++) {
                    var saTrack = srcSeq.audioTracks[sat];
                    for (var sac = 0; sac < saTrack.clips.numItems; sac++) {
                        var aClip = saTrack.clips[sac];
                        var aPi = null;
                        try { aPi = aClip.projectItem; } catch(e) {}
                        if (!aPi) { log.push("SFX clip " + sac + ": sem projectItem — skip"); continue; }

                        var aStart = 0, aIn = 0, aOut = 0;
                        try { aStart = parseFloat(aClip.start.ticks); } catch(e) {}
                        try { aIn = parseFloat(aClip.inPoint.ticks); } catch(e) {}
                        try { aOut = parseFloat(aClip.outPoint.ticks); } catch(e) {}

                        var aDstTicks = (baseTimeSec * TPS) + aStart - anchorTicks;
                        if (aDstTicks < 0) aDstTicks = 0;
                        var aDstTime = new Time(); aDstTime.ticks = String(aDstTicks);

                        try {
                            sfxTrack.overwriteClip(aPi, aDstTime);
                            audioInserted++;
                            // ajusta in/out pra match o trecho do template
                            var newA = null;
                            for (var nca = sfxTrack.clips.numItems - 1; nca >= 0; nca--) {
                                var ca = sfxTrack.clips[nca];
                                var cas2 = 0; try { cas2 = parseFloat(ca.start.ticks); } catch(e) {}
                                if (Math.abs(cas2 - aDstTicks) < TPS) { newA = ca; break; }
                            }
                            if (newA && (aIn > 0 || aOut > 0)) {
                                try { var aNi = new Time(); aNi.ticks = String(aIn); newA.inPoint = aNi; } catch(e) {}
                                try { var aNo = new Time(); aNo.ticks = String(aOut); newA.outPoint = aNo; } catch(e) {}
                            }
                        } catch(eAo) {
                            log.push("SFX clip " + sac + " overwriteClip ERR: " + eAo.message);
                        }
                    }
                }
                if (audioInserted > 0) {
                    log.push("SFX → A" + (_sfxAudioTrackIdx + 1) + ": " + audioInserted + " clip(s)");
                }
            }
        }
    } catch(eAudio) {
        log.push("SFX ERR: " + eAudio.message);
    }

    return {
        ok: (inserted > 0 || audioInserted > 0),
        inserted: inserted,
        audioInserted: audioInserted,
        tracksUsed: maxTrackUsed - baseTrackIndex + 1,
        clipPairs: clipPairs,
        log: log
    };
}

// Para modo EXPAND: copia TODAS as propriedades editáveis do clip src do
// template pro clip dst da main, substituindo placeholders ([[INFO]] etc) em
// valores de texto. Cobre:
//   • Texto estilizado (Text A, Text B com TextDocument completo)
//   • Cores (Line Color, Text Color, Shadow Color — bigInt values)
//   • Posições (Motion Position, Anchor Point, Position Control, Text Position)
//   • Escalas (Motion Scale, Scale Control)
//   • Outros params do MOGRT (Line Width, Direction, Distance, Opacity, etc)
//
// Por que isso é necessário: overwriteClip(MasterClip) cria o dst com os
// DEFAULTS absolutos do MOGRT/MasterClip — sem nenhuma das customizações que
// o usuário fez no clip-instance dentro do [TEMPLATE]LOWERTHIRD. Pra dst ficar
// igual ao template, precisamos transferir essas customizações.
//
// Estratégia: pareia props src/dst por displayName, copia src→dst com setValue.
// Skip silencioso de props read-only ou que dão erro (system-managed).
function copyClipTextWithSubstitutions(srcClip, dstClip, product, extras, logArr) {
    // Lista de props a NÃO copiar: causariam efeitos colaterais indesejados,
    // ou são identificadores únicos por clip que não fazem sentido transferir.
    var SKIP_PROPS = {
        "Source Text": true,    // EG nativo — controlado por outro caminho
        "Blend Mode": true      // geralmente default já é o correto
    };

    function indexPropsByName(propsCollection, out, depth) {
        if (depth > 4) return;
        for (var i = 0; i < propsCollection.numItems; i++) {
            var p = propsCollection[i];
            var dn = null;
            try { dn = p.displayName; } catch(e) {}
            if (dn && !out[dn]) out[dn] = p;
            if (p.properties && p.properties.numItems > 0) {
                indexPropsByName(p.properties, out, depth + 1);
            }
        }
    }
    function walkComponents(clip, out) {
        try {
            for (var i = 0; i < clip.components.numItems; i++) {
                var comp = clip.components[i];
                if (comp.properties && comp.properties.numItems > 0) {
                    indexPropsByName(comp.properties, out, 0);
                }
            }
        } catch(eW) {}
    }

    var srcMap = {}, dstMap = {};
    walkComponents(srcClip, srcMap);
    walkComponents(dstClip, dstMap);

    var applied = 0;
    var skipped = 0;
    for (var name in srcMap) {
        if (!srcMap.hasOwnProperty(name)) continue;
        if (SKIP_PROPS[name]) continue;
        var srcProp = srcMap[name];
        var dstProp = dstMap[name];
        if (!dstProp) continue;

        // Tenta como TEXTO primeiro (TextDocument estilizado com [[INFO]] etc)
        var textVal = getPropTextValue(srcProp);
        if (textVal && textVal.indexOf("[[") >= 0) {
            var subbed = applyTextSubstitutions(textVal, product || {}, extras);
            if (subbed !== null) {
                try {
                    dstProp.setValue(subbed, true);
                    logArr.push("[" + name + "] ✓TXT " + String(subbed).substring(0, 40));
                    applied++;
                    continue;
                } catch (eSetTxt) {
                    logArr.push("[" + name + "] TXT falhou: " + eSetTxt.message);
                }
            }
        }

        // Caso não-texto (ou texto sem [[]]): copia valor raw via getValue/setValue.
        // Cobre posições, cores, escalas, etc. do MOGRT.
        try {
            var rawVal = srcProp.getValue();
            if (rawVal === null || rawVal === undefined) { skipped++; continue; }
            try {
                dstProp.setValue(rawVal, true);
                applied++;
            } catch (eSetRaw) {
                skipped++;
                // silencioso pra não poluir log com props read-only
            }
        } catch (eGet) {
            skipped++;
        }
    }
    logArr.push("(total: " + applied + " copiada(s), " + skipped + " skipped/read-only)");
    return applied;
}

// ─── EXPORTAR TRANSCRIÇÃO ────────────────────────────────────────────────────

function exportTranscription(outputPath) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return JSON.stringify({ error: "Nenhuma sequência ativa no Premiere." });

        var fr = 30;
        try { fr = seq.getSettings().videoFrameRate; } catch (e) {}

        // Apaga arquivo prévio pra ter certeza que o exporte de agora é o que lemos.
        try { var prev = new File(outputPath); if (prev.exists) prev.remove(); } catch (eDel) {}

        var attempts = [];

        function readFileIfNonEmpty(p) {
            try {
                var f = new File(p);
                if (!f.exists) return null;
                f.encoding = "UTF-8"; f.open("r");
                var c = f.read(); f.close();
                if (c && c.replace(/\s/g, "").length > 0) return c;
            } catch (e) {}
            return null;
        }

        function tryMethod(name, fn) {
            try {
                fn();
                var c = readFileIfNonEmpty(outputPath);
                if (c) return c;
                attempts.push(name + ": ok mas arquivo vazio/ausente");
            } catch (e) {
                attempts.push(name + ": " + e.message);
            }
            return null;
        }

        var content = null;

        // 1) API estável: exportAsCaptions (precisa de legendas na timeline)
        content = tryMethod("seq.exportAsCaptions", function () {
            seq.exportAsCaptions(outputPath, "SRT", fr, 0, seq.end);
        });

        // 2) Tentativa direta na seq (algumas versões expõem)
        if (!content) {
            content = tryMethod("seq.exportAsTextBased", function () {
                seq.exportAsTextBased(outputPath);
            });
        }

        // 3) QE DOM como último recurso
        if (!content) {
            content = tryMethod("qe.exportAsTextBased", function () {
                app.enableQE();
                qe.project.getActiveSequence().exportAsTextBased(outputPath);
            });
        }

        // Diagnóstico: tem captions na timeline?
        var hasCaptions = false;
        try {
            if (seq.captionTracks && seq.captionTracks.numTracks) {
                for (var ct = 0; ct < seq.captionTracks.numTracks; ct++) {
                    var tr = seq.captionTracks[ct];
                    if (tr && tr.clips && tr.clips.numItems > 0) { hasCaptions = true; break; }
                }
            }
        } catch (eCt) {}

        if (!content) {
            var msg;
            if (!hasCaptions) {
                msg = "A sequência não tem LEGENDAS na timeline (só transcrição não basta). " +
                      "Solução: no painel Text → aba 'Legendas' → '+ Criar legendas a partir da transcrição'. " +
                      "Depois clique este botão de novo.";
            } else {
                msg = "Legendas existem mas a exportação falhou. " +
                      "Como fallback: no painel Text, exporte manualmente como .srt e use 'Carregar arquivo'.";
            }
            return JSON.stringify({ error: msg, hasCaptions: hasCaptions, attempts: attempts });
        }

        return JSON.stringify({ success: true, content: content, hasCaptions: hasCaptions });
    } catch (e) {
        return JSON.stringify({ error: e.message });
    }
}

// ─── ANIMAÇÕES ────────────────────────────────────────────────────────────────

// Variável global pra capturar diagnóstico da última chamada de applyAnimation
var _lastAnimDiag = null;

function applyAnimation(clip, animationType, baseScaleHint) {
    _lastAnimDiag = { step: "start", addMethods: [] };
    try {
        // Motion fica INTACTO — o scale-to-frame já aplicou 142% no Motion.Scale.

        // ── 1. Procura se Transform já existe no clip
        var transform = null;
        var existingComps = [];
        for (var k = 0; k < clip.components.numItems; k++) {
            var cmp = clip.components[k];
            var dn  = cmp.displayName || "";
            var mn  = cmp.matchName   || "";
            existingComps.push(dn + "[" + mn + "]");
            if (mn === "AE.ADBE Geometry2" || mn === "AE.ADBE Transform" ||
                dn === "Transform" || dn === "Transformar") {
                transform = cmp;
                _lastAnimDiag.addMethods.push("existing");
                break;
            }
        }
        _lastAnimDiag.existingComps = existingComps.join(", ");

        // ── 2. Se não existe, tenta adicionar de várias formas
        if (!transform) {
            // 2a. clip.components.addComponent(matchName)
            var matchNames = ["AE.ADBE Geometry2", "AE.ADBE Transform"];
            for (var ta = 0; ta < matchNames.length && !transform; ta++) {
                try {
                    var ret = clip.components.addComponent(matchNames[ta]);
                    _lastAnimDiag.addMethods.push("addComponent(" + matchNames[ta] + ")=" + (ret ? "ok" : "null"));
                    if (ret) transform = ret;
                } catch(e1) {
                    _lastAnimDiag.addMethods.push("addComponent(" + matchNames[ta] + ") ERR: " + e1.message.substring(0,60));
                }
            }

            // 2b. Após addComponent, mesmo se ret foi null, RE-PROCURA na lista
            // (porque algumas versões adicionam mas não retornam o objeto)
            if (!transform) {
                for (var k2 = 0; k2 < clip.components.numItems; k2++) {
                    var cmp2 = clip.components[k2];
                    var dn2  = cmp2.displayName || "";
                    var mn2  = cmp2.matchName   || "";
                    if (mn2 === "AE.ADBE Geometry2" || mn2 === "AE.ADBE Transform" ||
                        dn2 === "Transform" || dn2 === "Transformar") {
                        transform = cmp2;
                        _lastAnimDiag.addMethods.push("re-search ok");
                        break;
                    }
                }
            }

            // 2c. Fallback via QE — addVideoEffect espera OBJETO VideoEffect, não string!
            if (!transform) {
                try {
                    app.enableQE();
                    // Pega o objeto VideoEffect via getVideoEffectByName
                    var qeEffect = null;
                    var effectNames = ["Transform", "AE.ADBE Geometry2"];
                    for (var en = 0; en < effectNames.length && !qeEffect; en++) {
                        try {
                            qeEffect = qe.project.getVideoEffectByName(effectNames[en]);
                            if (qeEffect) {
                                _lastAnimDiag.addMethods.push("QE.getVideoEffectByName(" + effectNames[en] + ")=ok");
                                break;
                            }
                        } catch(eGE) {
                            _lastAnimDiag.addMethods.push("QE.getVideoEffectByName(" + effectNames[en] + ") ERR: " + eGE.message.substring(0,60));
                        }
                    }

                    if (!qeEffect) {
                        _lastAnimDiag.addMethods.push("QE: efeito não encontrado por nome");
                    } else {
                        // Acha o qeClip correspondente
                        var qeSeq = qe.project.getActiveSequence();
                        if (qeSeq) {
                            var targetTicks = parseFloat(clip.start.ticks);
                            for (var qt = 0; qt < qeSeq.numVideoTracks && !transform; qt++) {
                                var qeTr = qeSeq.getVideoTrackAt(qt);
                                for (var qc = 0; qc < qeTr.numItems && !transform; qc++) {
                                    var qeC = qeTr.getItemAt(qc);
                                    if (qeC && qeC.start && Math.abs(parseFloat(qeC.start.ticks) - targetTicks) < 254016000000) {
                                        try {
                                            qeC.addVideoEffect(qeEffect);
                                            _lastAnimDiag.addMethods.push("qeC.addVideoEffect(effect) ok");

                                            // SETA KEYFRAMES VIA QE DIRETAMENTE (o JS-side fica stale).
                                            // Calcula os valores aqui mesmo, baseado no animationType passado.
                                            var startV_QE, endV_QE;
                                            if (animationType === "zoom_in") {
                                                startV_QE = 100; endV_QE = 110;
                                            } else if (animationType === "zoom_out") {
                                                startV_QE = 110; endV_QE = 100;
                                            } else if (animationType === "zoom_detail") {
                                                startV_QE = 100; endV_QE = 120;
                                            } else {
                                                startV_QE = 100; endV_QE = 100;
                                            }

                                            // Itera componentes via QE pra achar o Transform
                                            var qeTransform = null;
                                            try {
                                                for (var qci = 0; qci < qeC.numComponents; qci++) {
                                                    var qeComp = qeC.getComponentAt(qci);
                                                    var qcName = qeComp ? (qeComp.name || "") : "";
                                                    if (qcName === "Transform" || qcName === "Transformar" ||
                                                        qcName === "AE.ADBE Geometry2") {
                                                        qeTransform = qeComp;
                                                        _lastAnimDiag.addMethods.push("QE component achou: " + qcName + " (idx=" + qci + ")");
                                                        break;
                                                    }
                                                }
                                            } catch(eQI) {
                                                _lastAnimDiag.addMethods.push("QE iter components ERR: " + eQI.message.substring(0,60));
                                            }

                                            if (qeTransform) {
                                                // DIAGNÓSTICO: lista todas as propriedades do qeTransform
                                                var qeTrPropList = [];
                                                var qeNumProps = 0;
                                                try { qeNumProps = qeTransform.numProperties; } catch(eNP) {
                                                    _lastAnimDiag.addMethods.push("QE numProperties ERR: " + eNP.message.substring(0,60));
                                                }
                                                _lastAnimDiag.addMethods.push("qeTransform.numProperties=" + qeNumProps);

                                                // Lista métodos disponíveis no qeTransform
                                                var qeTrMethods = [];
                                                try { for (var qtm in qeTransform) { if (typeof qeTransform[qtm] === "function") qeTrMethods.push(qtm); } } catch(e){}
                                                _lastAnimDiag.addMethods.push("qeTransform métodos: " + qeTrMethods.slice(0,20).join(","));

                                                // Acha a propriedade Scale via QE
                                                var qeScaleProp = null;
                                                try {
                                                    for (var qpi = 0; qpi < qeNumProps; qpi++) {
                                                        var qeProp = qeTransform.getPropertyAt(qpi);
                                                        var qpName = qeProp ? (qeProp.name || "?") : "null";
                                                        qeTrPropList.push("[" + qpi + "]" + qpName);
                                                        if (qpName === "Scale" || qpName === "Escala") {
                                                            qeScaleProp = qeProp;
                                                        }
                                                    }
                                                } catch(eQP) {
                                                    _lastAnimDiag.addMethods.push("QE iter props ERR: " + eQP.message.substring(0,60));
                                                }
                                                _lastAnimDiag.addMethods.push("qeTransform props: " + qeTrPropList.join(","));

                                                if (qeScaleProp) {
                                                    // Tenta setar keyframes via QE — várias APIs possíveis
                                                    var qeStartTime = new Time(); qeStartTime.ticks = String(clip.start.ticks);
                                                    var qeEndTime   = new Time(); qeEndTime.ticks   = String(clip.end.ticks);

                                                    var setVia = "";
                                                    // Tenta setValue (alguns QE props aceitam time + value)
                                                    try {
                                                        if (typeof qeScaleProp.setValue === "function") {
                                                            qeScaleProp.setValue(qeStartTime, startV_QE);
                                                            qeScaleProp.setValue(qeEndTime, endV_QE);
                                                            setVia = "QE.setValue";
                                                        } else if (typeof qeScaleProp.setValueAtTime === "function") {
                                                            qeScaleProp.setValueAtTime(qeStartTime, startV_QE);
                                                            qeScaleProp.setValueAtTime(qeEndTime, endV_QE);
                                                            setVia = "QE.setValueAtTime";
                                                        } else if (typeof qeScaleProp.setKey === "function") {
                                                            qeScaleProp.setKey(qeStartTime, startV_QE);
                                                            qeScaleProp.setKey(qeEndTime, endV_QE);
                                                            setVia = "QE.setKey";
                                                        }
                                                        _lastAnimDiag.addMethods.push("QE keyframes setadas via " + setVia + " (" + startV_QE + " → " + endV_QE + ")");
                                                        // Marca transform como "encontrado" pra evitar fallback
                                                        transform = { _viaQE: true, qeRef: qeTransform };
                                                    } catch(eSV) {
                                                        _lastAnimDiag.addMethods.push("QE setValue ERR: " + eSV.message.substring(0,80));
                                                        // Lista métodos disponíveis pra debug
                                                        var qeMethods = [];
                                                        try { for (var qm in qeScaleProp) { if (typeof qeScaleProp[qm] === "function") qeMethods.push(qm); } } catch(e){}
                                                        _lastAnimDiag.addMethods.push("QE prop métodos: " + qeMethods.slice(0,15).join(","));
                                                    }
                                                }
                                            }
                                        } catch(eAV) {
                                            _lastAnimDiag.addMethods.push("qeC.addVideoEffect ERR: " + eAV.message.substring(0,80));
                                        }
                                        break;
                                    }
                                }
                            }
                        }
                    }
                } catch(eQEout) {
                    _lastAnimDiag.addMethods.push("QE setup ERR: " + eQEout.message.substring(0,80));
                }
            }
        }

        if (!transform) {
            _lastAnimDiag.step = "no-transform";
            return;
        }
        // Se já setamos via QE, terminamos aqui — não tenta JS-side
        if (transform._viaQE) {
            _lastAnimDiag.step = "transform-via-qe-done";
            return;
        }
        _lastAnimDiag.step = "transform-found";

        // ── 2. Encontra Scale e Position dentro do Transform
        var tScaleProp = null;
        var tPosProp   = null;
        for (var m = 0; m < transform.properties.numItems; m++) {
            var tp   = transform.properties[m];
            var tpDN = tp.displayName || "";
            if (tpDN === "Scale"    || tpDN === "Escala")    tScaleProp = tp;
            if (tpDN === "Position" || tpDN === "Posição")   tPosProp   = tp;
        }
        if (!tScaleProp) return;

        // ── 3. Valores de start/end no TRANSFORM (sempre relativos a 100%)
        // 100% no Transform = "sem mudança" (mantém o que Motion já fez = 142% fit).
        // 110% no Transform = +10% zoom em cima do fit (= ~156% visual).
        // Valores baseados nos presets exportados pelo usuário (AUTO EDIT ZOOM IN/OUT).
        var BASE_PCT     = 100;
        var ZOOM_DELTA   = 10;  // zoom_in/out: 100 ↔ 110
        var DETAIL_DELTA = 20;

        var startVal, endVal;
        if (animationType === "zoom_in") {
            startVal = BASE_PCT;
            endVal   = BASE_PCT + ZOOM_DELTA;
        } else if (animationType === "zoom_out") {
            startVal = BASE_PCT + ZOOM_DELTA;
            endVal   = BASE_PCT;
        } else if (animationType === "zoom_detail") {
            startVal = BASE_PCT;
            endVal   = BASE_PCT + DETAIL_DELTA;
        } else if (animationType === "pan_left" || animationType === "pan_right") {
            startVal = BASE_PCT + 15;
            endVal   = BASE_PCT + 15;
        } else {
            return;
        }

        // ── 5. Helper que cria keyframe respeitando o snap pra frame do Premiere
        function setKeyframe(prop, time, val) {
            try {
                prop.addKey(time);
                var idx = prop.numKeys - 1;
                var actualTime = time;
                try { actualTime = prop.getKeyTime(idx); } catch(eGT) {}
                prop.setValueAtKey(actualTime, val, true);
            } catch(eK) {}
        }

        var s = clip.start;
        var e = clip.end;

        // Aplica scale no Transform
        setKeyframe(tScaleProp, s, startVal);
        setKeyframe(tScaleProp, e, endVal);

        // Position pra animações que precisam (pan/zoom_detail)
        if (tPosProp) {
            if (animationType === "zoom_detail") {
                setKeyframe(tPosProp, s, [960, 540]);
                setKeyframe(tPosProp, e, [890, 490]);
            } else if (animationType === "pan_left") {
                setKeyframe(tPosProp, s, [1010, 540]);
                setKeyframe(tPosProp, e, [910,  540]);
            } else if (animationType === "pan_right") {
                setKeyframe(tPosProp, s, [910,  540]);
                setKeyframe(tPosProp, e, [1010, 540]);
            }
        }
    } catch (e) { /* animação não é crítica */ }
}

// Aplica "Scale to Frame Size" no clip que começa em startTimeTicks na track dada.
// Equivale ao clique direito → "Set to Frame Size" no Premiere.
//
// hintSrcW/hintSrcH: dimensões da fonte pré-computadas pelo JS (lendo PNG/JPEG header).
// Usadas com prioridade se passadas. Caso contrário, tenta extrair via XMP/footage.
//
// Retorna { ok, method, scale } pra log.
function applyScaleToFrameSize(seq, track, startTimeTicks, hintSrcW, hintSrcH) {
    var result = { ok: false, method: "none" };

    // ── Encontra o clip JS na track ────────────────────────────────────────
    // O Premiere faz snap pra frame boundary — o tick salvo pode diferir do que
    // pedimos por até ~16ms (≈ 4 bilhões de ticks). Acha o clip MAIS PRÓXIMO
    // do target e aceita se a distância for razoável (< 1s, slots têm 5s).
    var clip = null;
    var bestDiff = Infinity;
    var SANE_TICKS = 254016000000; // 1 segundo
    try {
        var targetNum = parseFloat(String(startTimeTicks));
        for (var i = 0; i < track.clips.numItems; i++) {
            var c = track.clips[i];
            if (!c || !c.start) continue;
            var diff = Math.abs(parseFloat(c.start.ticks) - targetNum);
            if (diff < bestDiff) {
                bestDiff = diff;
                clip = c;
            }
        }
        if (clip && bestDiff > SANE_TICKS) clip = null; // proteção contra match errado
    } catch(e) {}
    if (!clip) {
        result.method = "clip-not-found (target ticks=" + startTimeTicks +
                        ", closest diff=" + (bestDiff === Infinity ? "none" : bestDiff) + ")";
        return result;
    }

    // ── Estratégia 1: calcula scale via dimensões da fonte vs sequência ────
    try {
        var seqSettings = seq.getSettings();
        var seqW = seqSettings.videoFrameWidth;
        var seqH = seqSettings.videoFrameHeight;

        // Prioridade: dimensões passadas pelo JS (via PNG/JPEG header — confiável)
        var srcW = 0, srcH = 0;
        var xmpSnippet = "";
        var dimSource = "";
        if (hintSrcW && hintSrcH && hintSrcW > 0 && hintSrcH > 0) {
            srcW = hintSrcW;
            srcH = hintSrcH;
            dimSource = "hint";
        }
        try {
            if ((!srcW || !srcH)) {
            var pi = clip.projectItem;
            if (pi) {
                // Tenta via XMP metadata
                var xmp = "";
                try { xmp = pi.getProjectMetadata(); } catch(eXmp) {}
                if (xmp) {
                    // Diversos padrões usados pelo Premiere/XMP
                    var patterns = [
                        [/<premierePrivateProjectMetaData:Column\.Intrinsic\.MediaWidth>(\d+)</,  /<premierePrivateProjectMetaData:Column\.Intrinsic\.MediaHeight>(\d+)</],
                        [/<premierePrivateProjectMetaData:Column\.Intrinsic\.VideoInfo>.*?(\d+)\s*x\s*(\d+)/, null],
                        [/<stDim:w>(\d+)<\/stDim:w>/,             /<stDim:h>(\d+)<\/stDim:h>/],
                        [/<tiff:ImageWidth>(\d+)<\/tiff:ImageWidth>/, /<tiff:ImageLength>(\d+)<\/tiff:ImageLength>/],
                        [/<exif:PixelXDimension>(\d+)</,          /<exif:PixelYDimension>(\d+)</],
                        [/<xmpDM:videoFrameSize[^>]*>\s*<stDim:w>(\d+)<\/stDim:w>\s*<stDim:h>(\d+)<\/stDim:h>/, null]
                    ];
                    for (var pi2 = 0; pi2 < patterns.length && (!srcW || !srcH); pi2++) {
                        var pat = patterns[pi2];
                        if (pat[1]) {
                            var m1 = xmp.match(pat[0]);
                            var m2 = xmp.match(pat[1]);
                            if (m1) srcW = parseInt(m1[1], 10);
                            if (m2) srcH = parseInt(m2[1], 10);
                        } else {
                            var m3 = xmp.match(pat[0]);
                            if (m3 && m3[1] && m3[2]) {
                                srcW = parseInt(m3[1], 10);
                                srcH = parseInt(m3[2], 10);
                            }
                        }
                    }
                    // Pega um snippet do XMP pra debug se não achou
                    if (!srcW || !srcH) {
                        xmpSnippet = xmp.substring(0, 200).replace(/\s+/g, " ");
                    }
                }
                // Fallback: getFootageInterpretation
                if ((!srcW || !srcH) && typeof pi.getFootageInterpretation === "function") {
                    try {
                        var fi = pi.getFootageInterpretation();
                        if (fi && fi.frameWidth)  srcW = fi.frameWidth;
                        if (fi && fi.frameHeight) srcH = fi.frameHeight;
                    } catch(eFI) {}
                }
                if (srcW && srcH && !dimSource) dimSource = "xmp/footage";
            }
            } // fecha if ((!srcW || !srcH))
        } catch(eDim) {}

        if (srcW > 0 && srcH > 0 && seqW > 0 && seqH > 0) {
            // FILL (cobre todo o frame, pode cortar) = max ratio, com 1% de margem
            // de segurança pra eliminar bordas finas que podem ficar por arredondamento.
            var ratio = Math.max(seqW / srcW, seqH / srcH) * 1.01;
            var scalePct = ratio * 100;

            // Lista nomes possíveis do componente Motion (varia por locale)
            var motionNames  = ["Motion", "Movimento"];
            var scaleNames   = ["Scale", "Escala"];

            var motion = null;
            var motionDisplayNames = [];
            for (var ci = 0; ci < clip.components.numItems; ci++) {
                var compDN = clip.components[ci].displayName || "";
                motionDisplayNames.push(compDN);
                for (var mn = 0; mn < motionNames.length; mn++) {
                    if (compDN === motionNames[mn]) { motion = clip.components[ci]; break; }
                }
                if (motion) break;
            }
            if (motion) {
                var scaleProp = null;
                var scalePropNames = [];
                for (var pj = 0; pj < motion.properties.numItems; pj++) {
                    var propDN = motion.properties[pj].displayName || "";
                    scalePropNames.push(propDN);
                    for (var sn = 0; sn < scaleNames.length; sn++) {
                        if (propDN === scaleNames[sn]) { scaleProp = motion.properties[pj]; break; }
                    }
                    if (scaleProp) break;
                }
                if (scaleProp) {
                    try {
                        scaleProp.setValue(scalePct, true);
                        result.ok = true;
                        result.method = "motion-scale[" + dimSource + "]";
                        result.scale = scalePct;
                        result.srcW = srcW; result.srcH = srcH;
                        result.seqW = seqW; result.seqH = seqH;
                        return result;
                    } catch(eSetScale) { result.method = "setValue-err: " + eSetScale.message; }
                } else {
                    result.method = "no-scale-prop (props=" + scalePropNames.join(",") + ")";
                }
            } else {
                result.method = "no-motion-comp (comps=" + motionDisplayNames.join(",") + ")";
            }
        } else {
            result.method = "no-dims (src=" + srcW + "x" + srcH + " seq=" + seqW + "x" + seqH + ")";
            if (xmpSnippet) result.xmpSnippet = xmpSnippet;
        }
    } catch(eS1) { result.method = "s1-err: " + eS1.message; }

    // ── Estratégia 2: QE setScaleToFrameSize ───────────────────────────────
    try {
        app.enableQE();
        var prevActive = app.project.activeSequence;
        var needSwitch = (prevActive !== seq);
        if (needSwitch) {
            try { app.project.activeSequence = seq; } catch(eA) {}
        }
        var qeSeq = qe.project.getActiveSequence();
        if (qeSeq) {
            var qeTrack = null;
            for (var qt = 0; qt < qeSeq.numVideoTracks; qt++) {
                var trk = qeSeq.getVideoTrackAt(qt);
                if (trk && trk.name === track.name) { qeTrack = trk; break; }
            }
            if (qeTrack) {
                for (var qi = 0; qi < qeTrack.numItems; qi++) {
                    var qeClip = qeTrack.getItemAt(qi);
                    if (qeClip && qeClip.start && String(qeClip.start.ticks) === target) {
                        if (typeof qeClip.setScaleToFrameSize === 'function') {
                            try {
                                qeClip.setScaleToFrameSize();
                                result.ok = true;
                                result.method = "qe-setScaleToFrameSize";
                            } catch(eQE) { result.method = "qe-err: " + eQE.message; }
                        } else {
                            result.method = "qe-method-missing";
                        }
                        break;
                    }
                }
            }
        }
        if (needSwitch) { try { app.project.activeSequence = prevActive; } catch(e){} }
    } catch(eS2) { result.method += " | s2-err: " + eS2.message; }

    return result;
}

// ─── INSERIR MÍDIA ────────────────────────────────────────────────────────────

function insertMediaAtTime(filePath, trackIndex, startSec, durationSec, animationType, srcW, srcH) {
    try {
        var seq  = app.project.activeSequence;
        var item = importAndGet(filePath);
        if (!item) return JSON.stringify({ error: "Arquivo não encontrado: " + filePath });

        var track     = ensureVideoTrack(seq, trackIndex);
        var startTime = new Time();
        startTime.ticks = toTicks(startSec);

        track.overwriteClip(item, startTime);

        // Acha o clip MAIS PRÓXIMO do startTime (tolerance grande pra lidar
        // com snap pra frame do Premiere)
        var bestClip = null;
        if (durationSec > 0) {
            var targetT = parseFloat(startTime.ticks);
            var bestDD = Infinity;
            for (var c = 0; c < track.clips.numItems; c++) {
                var cc = track.clips[c];
                if (!cc || !cc.start) continue;
                var dd = Math.abs(parseFloat(cc.start.ticks) - targetT);
                if (dd < bestDD) { bestDD = dd; bestClip = cc; }
            }
            // Aceita se < 1s (slots têm pelo menos 5s de distância)
            if (bestClip && bestDD < 254016000000) {
                var endTime = new Time();
                endTime.ticks = toTicks(startSec + durationSec);
                bestClip.end = endTime;
            } else {
                bestClip = null;
            }
        }

        // 1. Aplica "Scale to Frame Size" PRIMEIRO — define a escala base (~142%).
        var sfRes = { method: "skipped" };
        try { sfRes = applyScaleToFrameSize(seq, track, startTime.ticks, srcW, srcH); } catch(eSF) { sfRes = { method: "err: " + eSF.message }; }

        // 2. Aplica animação DEPOIS — passa a baseScale explicitamente (do resultado
        //    do scale-to-frame) pra não depender de scaleProp.getValue() que às
        //    vezes retorna valor antigo logo após setValue.
        var baseFromSF = (sfRes && sfRes.ok && sfRes.scale) ? sfRes.scale : 100;
        var animInfo = { type: animationType, baseScale: baseFromSF };
        if (bestClip && animationType && animationType !== "none") {
            _lastAnimDiag = null;
            try { applyAnimation(bestClip, animationType, baseFromSF); } catch(eA) { animInfo.err = eA.message; }
            if (_lastAnimDiag) {
                animInfo.diag = _lastAnimDiag;
            }
            // Lê o valor final do Transform → Scale pra confirmar o que ficou
            try {
                var trC = null;
                for (var mi = 0; mi < bestClip.components.numItems; mi++) {
                    var cdn = bestClip.components[mi].displayName || "";
                    var cmn = bestClip.components[mi].matchName   || "";
                    if (cmn === "AE.ADBE Geometry2" || cmn === "AE.ADBE Transform" ||
                        cdn === "Transform" || cdn === "Transformar") {
                        trC = bestClip.components[mi];
                        break;
                    }
                }
                if (trC) {
                    animInfo.transformFound = true;
                    for (var pi = 0; pi < trC.properties.numItems; pi++) {
                        var pdn = trC.properties[pi].displayName || "";
                        if (pdn === "Scale" || pdn === "Escala") {
                            try { animInfo.actualScale = trC.properties[pi].getValue(); } catch(eRV) {}
                            try { animInfo.numKeys = trC.properties[pi].numKeys; } catch(eNK) {}
                            break;
                        }
                    }
                } else {
                    animInfo.transformFound = false;
                }
            } catch(eRead) {}
        }

        return JSON.stringify({ success: true, scaleToFrame: sfRes, animation: animInfo });
    } catch (e) {
        return JSON.stringify({ error: e.message });
    }
}

// ─── SISTEMA DE TEMPLATES ─────────────────────────────────────────────────────

// Encontra uma sequência template pelo nome (com ou sem prefixo [TEMPLATE])
function findTemplateSequence(templateName) {
    var n = app.project.sequences.numSequences;
    for (var i = 0; i < n; i++) {
        var s = app.project.sequences[i];
        if (s.name === "[TEMPLATE] " + templateName || s.name === "[TEMPLATE]" + templateName || s.name === templateName) {
            return s;
        }
    }
    return null;
}

// Procura na bin (project root) por um MasterClip/ProjectItem com nome
// [TEMPLATE]NAME. Usado pra suporte a templates que são clips configurados
// (dragados da timeline pra bin), em vez de sequências aninhadas.
//
// Vantagem: clip já tem todas as customizações (cores, posição, escala, texto
// com [[INFO]]) bakeadas. Insere via overwriteClip e nova instância nasce com
// tudo certo — só precisa substituir placeholders de texto.
//
// IMPORTANTE: filtra sequence proxies por IDENTIDADE (não nome). Suporta o caso
// onde o usuário tem AMBOS uma Sequence E um MasterClip com o mesmo nome —
// retorna o MasterClip corretamente.
function findTemplateProjectItem(templateName) {
    var targets = [
        "[TEMPLATE] " + templateName,
        "[TEMPLATE]"  + templateName,
        templateName
    ];

    // Constrói set de project items que SÃO sequences (por identidade real)
    var sequenceItems = []; // array de ProjectItems que representam Sequences
    try {
        for (var sq = 0; sq < app.project.sequences.numSequences; sq++) {
            try {
                var seq = app.project.sequences[sq];
                if (seq && seq.projectItem) sequenceItems.push(seq.projectItem);
            } catch(eSP) {}
        }
    } catch(eSL) {}

    function isSequenceProxy(item) {
        // Compara por referência direta (mais confiável que nome)
        for (var i = 0; i < sequenceItems.length; i++) {
            if (item === sequenceItems[i]) return true;
            // Fallback: nodeId match
            try {
                if (item.nodeId && sequenceItems[i].nodeId &&
                    item.nodeId === sequenceItems[i].nodeId) return true;
            } catch(eN) {}
        }
        return false;
    }

    function search(parent, depth) {
        if (depth > 6) return null; // anti loop em bins muito aninhadas
        for (var i = 0; i < parent.children.numItems; i++) {
            var child = parent.children[i];
            for (var t = 0; t < targets.length; t++) {
                if (child.name === targets[t]) {
                    if (!isSequenceProxy(child)) return child;
                    // É sequence proxy — continua procurando (pode haver MasterClip com mesmo nome)
                    break;
                }
            }
            // Recurse em bins
            if (child.children && child.children.numItems > 0) {
                var found = search(child, depth + 1);
                if (found) return found;
            }
        }
        return null;
    }
    return search(app.project.rootItem, 0);
}

// ─── PRESET APPLICATION VIA PASTE ATTRIBUTES ──────────────────────────────
// Aplica preset de efeitos (zoom in/out etc) nas imagens auto-fill do main
// timeline, usando uma sequência [PRESET]NOME como fonte. User configura
// manualmente um clip nessa seq com o preset desejado; plugin replica
// via Copy + Paste Attributes (executeCommand) pra todos os targets.
//
// targetsJSON: array de { trackIndex, startSec, presetName }
//   presetName: "ZOOMIN" ou "ZOOMOUT" — usado pra achar seq [PRESET]NOME
// ──────────────────────────────────────────────────────────────────────
// applyPresetsFromBin: copia efeitos+keyframes de um clip-fonte (em uma
// sequência [PRESET]NAME) pra clips alvo na main seq, usando a API
// nativa de Components/Properties. Funciona sem menu commands.
//
// Pra cada target:
//   1. Acha clip-fonte da seq [PRESET]<presetName>
//   2. Pra cada componente do source:
//      - Acha (ou adiciona via QE) componente correspondente no target
//      - Pra cada property: copia valor estático OU keyframes
// ──────────────────────────────────────────────────────────────────────
function applyPresetsFromBin(targetsJSON) {
    var log = [];

    // ── Helpers ────────────────────────────────────────────────────────
    function safeGetMatchName(comp) {
        try { return comp.matchName || ""; } catch(e) { return ""; }
    }
    function safeGetDisplayName(comp) {
        try { return comp.displayName || ""; } catch(e) { return ""; }
    }

    // Acha componente em destComps que case com srcComp (por matchName)
    function findMatchingComponent(destComps, srcMatchName, skipIndex) {
        if (!srcMatchName) return null;
        for (var i = 0; i < destComps.numItems; i++) {
            if (skipIndex != null && i <= skipIndex) continue;
            try {
                if (destComps[i].matchName === srcMatchName) return destComps[i];
            } catch(e) {}
        }
        return null;
    }

    // Copia uma property (valor + keyframes, se houver)
    function copyProperty(srcProp, tgtProp) {
        if (!srcProp || !tgtProp) return false;
        var isTV = false;
        try { isTV = srcProp.isTimeVarying(); } catch(e) {}

        if (isTV) {
            // Timeline com keyframes
            try { tgtProp.setTimeVarying(true); } catch(eTV) {}
            // Limpa keys antigos do target
            try {
                var oldKeys = tgtProp.getKeys();
                if (oldKeys) {
                    for (var k = oldKeys.length - 1; k >= 0; k--) {
                        try { tgtProp.removeKey(oldKeys[k]); } catch(eRK) {}
                    }
                }
            } catch(eRK1) {}
            // Copia keys do source
            var srcKeys;
            try { srcKeys = srcProp.getKeys(); } catch(eGK) { srcKeys = null; }
            if (!srcKeys || !srcKeys.length) {
                try {
                    var v = srcProp.getValue();
                    tgtProp.setValue(v, true);
                } catch(eSV) {}
                return true;
            }
            var copied = 0;
            for (var ki = 0; ki < srcKeys.length; ki++) {
                var tt = srcKeys[ki];
                try {
                    var val = srcProp.getValueAtKey(tt);
                    tgtProp.addKey(tt);
                    tgtProp.setValueAtKey(tt, val, true);
                    copied++;
                } catch(eKC) {}
            }
            return copied > 0;
        } else {
            // Valor estático
            try {
                var v2 = srcProp.getValue();
                tgtProp.setValue(v2, true);
                return true;
            } catch(eSV2) { return false; }
        }
    }

    // Copia todas as properties de srcComp pra tgtComp
    function copyComponentProps(srcComp, tgtComp) {
        var srcProps, tgtProps;
        try { srcProps = srcComp.properties; } catch(e) { return 0; }
        try { tgtProps = tgtComp.properties; } catch(e) { return 0; }
        if (!srcProps || !tgtProps) return 0;

        var nOk = 0;
        for (var i = 0; i < srcProps.numItems; i++) {
            var sp = null, tp = null;
            try { sp = srcProps[i]; } catch(eSP) { continue; }
            if (!sp) continue;
            try { tp = tgtProps[i]; } catch(eTP) {}
            // Fallback: match por displayName
            if (!tp || (function() {
                try { return sp.displayName !== tp.displayName; } catch(e) { return false; }
            })()) {
                var spName = "";
                try { spName = sp.displayName; } catch(e) {}
                for (var j = 0; j < tgtProps.numItems; j++) {
                    try {
                        if (tgtProps[j].displayName === spName) { tp = tgtProps[j]; break; }
                    } catch(e) {}
                }
            }
            if (!tp) continue;
            if (copyProperty(sp, tp)) nOk++;
        }
        return nOk;
    }

    // Adiciona efeito via QE pelo matchName
    function addEffectViaQE(targetClip, presetSeqName, matchName) {
        try {
            if (!app.enableQE) return false;
            app.enableQE();
            if (typeof qe === "undefined" || !qe) return false;
            // Acha o qe.activeSequence (= main seq aqui)
            var qeSeq = qe.project.getActiveSequence();
            if (!qeSeq) return false;
            // Tem que ter sido feito switch pra main seq antes de chamar isso
            // Acha o qe clip equivalente — varre tracks/clips
            var found = null;
            for (var tt = 0; tt < qeSeq.numVideoTracks; tt++) {
                var qt = qeSeq.getVideoTrackAt(tt);
                for (var cc = 0; cc < qt.numItems; cc++) {
                    var qc = qt.getItemAt(cc);
                    try {
                        if (qc.name === targetClip.name) {
                            var qs = 0, ts = 0;
                            try { qs = parseFloat(qc.start.ticks); } catch(e) {}
                            try { ts = parseFloat(targetClip.start.ticks); } catch(e) {}
                            if (Math.abs(qs - ts) < 100000000) { found = qc; break; }
                        }
                    } catch(eMatch) {}
                }
                if (found) break;
            }
            if (!found) return false;
            found.addVideoEffect(matchName);
            return true;
        } catch(e) { return false; }
    }

    try {
        var targets = eval("(" + targetsJSON + ")");
        if (!targets || !targets.length) {
            return JSON.stringify({ ok: false, error: "Nenhum target fornecido", log: log });
        }

        var mainSeq = app.project.activeSequence;
        if (!mainSeq) {
            return JSON.stringify({ ok: false, error: "Nenhuma sequência ativa", log: log });
        }
        log.push("Main seq: " + mainSeq.name + " (" + targets.length + " targets)");

        // Agrupa targets por presetName
        var groups = {};
        for (var i = 0; i < targets.length; i++) {
            var t = targets[i];
            if (!groups[t.presetName]) groups[t.presetName] = [];
            groups[t.presetName].push(t);
        }

        var TPS = 254016000000;
        var totalApplied = 0;
        var totalFailed  = 0;

        // Pré-resolve as preset seqs + clips fonte uma vez
        var sources = {}; // presetName -> { seq, clip, components: [{matchName, displayName, isIntrinsic}] }
        for (var pn in groups) {
            if (!groups.hasOwnProperty(pn)) continue;
            log.push("");
            log.push("=== Resolvendo preset " + pn + " ===");

            var presetSeq = null;
            for (var s = 0; s < app.project.sequences.numSequences; s++) {
                var sq = app.project.sequences[s];
                if (sq.name === "[PRESET]" + pn ||
                    sq.name === "[PRESET] " + pn) {
                    presetSeq = sq; break;
                }
            }
            if (!presetSeq) {
                log.push("ERR: seq [PRESET]" + pn + " não encontrada");
                sources[pn] = null;
                continue;
            }

            var sClip = null;
            for (var pt = 0; pt < presetSeq.videoTracks.numTracks && !sClip; pt++) {
                var ptr = presetSeq.videoTracks[pt];
                if (ptr.clips.numItems > 0) { sClip = ptr.clips[0]; break; }
            }
            if (!sClip) {
                log.push("ERR: " + presetSeq.name + " não tem clip");
                sources[pn] = null;
                continue;
            }

            // Lista components do source
            var comps = [];
            try {
                var sc = sClip.components;
                for (var ci = 0; ci < sc.numItems; ci++) {
                    try {
                        comps.push({
                            matchName:   safeGetMatchName(sc[ci]),
                            displayName: safeGetDisplayName(sc[ci]),
                            index: ci
                        });
                    } catch(eCi) {}
                }
            } catch(eCm) {}

            log.push("Source: " + presetSeq.name + " / " + sClip.name + " (" + comps.length + " components)");
            for (var cl = 0; cl < comps.length; cl++) {
                log.push("  [" + cl + "] " + comps[cl].displayName + " (" + comps[cl].matchName + ")");
            }
            sources[pn] = { seq: presetSeq, clip: sClip, comps: comps };
        }

        // Agora aplica em cada target
        log.push("");
        log.push("=== Aplicando em " + targets.length + " target(s) ===");

        // Garante main seq ativa
        try { app.project.activeSequence = mainSeq; } catch(e) {}

        for (var idx = 0; idx < targets.length; idx++) {
            var tg = targets[idx];
            var src = sources[tg.presetName];
            if (!src) { totalFailed++; continue; }

            // Acha o target clip na main seq
            var tgTrack = null;
            try { tgTrack = mainSeq.videoTracks[tg.trackIndex]; } catch(e) {}
            if (!tgTrack) { totalFailed++; continue; }

            var tgStartTicks = tg.startSec * TPS;
            var tgClip = null;
            for (var tc = 0; tc < tgTrack.clips.numItems; tc++) {
                var cand = tgTrack.clips[tc];
                var cs = 0;
                try { cs = parseFloat(cand.start.ticks); } catch(eC) {}
                if (Math.abs(cs - tgStartTicks) < TPS * 0.5) { tgClip = cand; break; }
            }
            if (!tgClip) {
                totalFailed++;
                if (idx < 5) log.push("ERR target #" + idx + ": clip não encontrado em V" + (tg.trackIndex+1) + " @ " + tg.startSec.toFixed(2) + "s");
                continue;
            }

            // Pra cada componente do source, copia pro target
            var nCompsCopied = 0;
            var srcComps = src.clip.components;
            var tgtComps = tgClip.components;

            for (var sci = 0; sci < src.comps.length; sci++) {
                var info = src.comps[sci];
                if (!info.matchName) continue;

                var srcComp = null;
                try { srcComp = srcComps[info.index]; } catch(eS) { continue; }
                if (!srcComp) continue;

                // Acha componente correspondente no target
                var tgtComp = findMatchingComponent(tgtComps, info.matchName, -1);

                // Se não tem e não é intrinsic óbvio (Motion/Opacity), tenta adicionar via QE
                if (!tgtComp) {
                    var isIntrinsic = (info.matchName.indexOf("AE.ADBE Motion") >= 0 ||
                                       info.matchName.indexOf("AE.ADBE Opacity") >= 0 ||
                                       info.matchName.indexOf("AE.ADBE Time") >= 0);
                    if (!isIntrinsic) {
                        var added = addEffectViaQE(tgClip, src.seq.name, info.matchName);
                        if (added) {
                            // Recarrega components — adiciona no final
                            try { tgtComps = tgClip.components; } catch(eR) {}
                            tgtComp = findMatchingComponent(tgtComps, info.matchName, -1);
                        }
                    }
                    if (!tgtComp) {
                        if (idx === 0) log.push("  skip: " + info.displayName + " (não tem no target e QE falhou)");
                        continue;
                    }
                }

                var nProps = copyComponentProps(srcComp, tgtComp);
                if (idx === 0) log.push("  comp '" + info.displayName + "': " + nProps + " props copiadas");
                if (nProps > 0) nCompsCopied++;
            }

            if (nCompsCopied > 0) totalApplied++;
            else totalFailed++;
        }

        log.push("");
        log.push("Resultado: " + totalApplied + " target(s) com preset aplicado, " + totalFailed + " falha(s)");

        return JSON.stringify({
            ok: totalApplied > 0,
            applied: totalApplied,
            failed: totalFailed,
            log: log
        });
    } catch(e) {
        return JSON.stringify({ ok: false, error: e.message, log: log });
    }
}

// DEBUG: inspeciona os clips de uma sequência [TEMPLATE]NAME pra descobrir
// o que são (adjustment layer? nested seq? media sintética?) e por que
// projectItem vem nulo. Roda rápido, sem mexer em nada.
function debugInspectTemplate(templateName) {
    try {
        var seq = findTemplateSequence(templateName);
        if (!seq) return JSON.stringify({ error: "Sequence [TEMPLATE]" + templateName + " não encontrada" });

        var lines = [];
        lines.push("Sequence: " + seq.name + " (" + seq.videoTracks.numTracks + " video tracks)");

        for (var t = 0; t < seq.videoTracks.numTracks; t++) {
            var track = seq.videoTracks[t];
            if (track.clips.numItems === 0) continue;
            lines.push("── V" + (t+1) + ": " + track.clips.numItems + " clip(s) ──");
            for (var c = 0; c < track.clips.numItems; c++) {
                var clip = track.clips[c];
                var d = ["  [" + c + "]"];
                try { d.push("name='" + clip.name + "'"); } catch(e) {}
                try { d.push("mediaType=" + clip.mediaType); } catch(e) {}
                try { d.push("type=" + clip.type); } catch(e) {}
                try { d.push("nodeId=" + clip.nodeId); } catch(e) {}
                try { d.push("isAdjLayer=" + clip.isAdjustmentLayer()); } catch(e) {}
                try { d.push("start=" + (parseFloat(clip.start.ticks)/254016000000).toFixed(3) + "s"); } catch(e) {}
                try { d.push("end=" + (parseFloat(clip.end.ticks)/254016000000).toFixed(3) + "s"); } catch(e) {}
                // projectItem
                var pi = null, piErr = "";
                try { pi = clip.projectItem; } catch(e) { piErr = e.message; }
                if (piErr) d.push("projectItem THREW:" + piErr);
                else if (!pi) d.push("projectItem=null");
                else {
                    d.push("projectItem.name='" + (function(){ try { return pi.name; } catch(e){ return "?"; } })() + "'");
                    try { d.push("pi.type=" + pi.type); } catch(e) {}
                    try { d.push("pi.mediaPath='" + pi.getMediaPath() + "'"); } catch(e) {}
                    try { d.push("pi.isSequence=" + pi.isSequence()); } catch(e) {}
                }
                // components (efeitos)
                try {
                    var cn = [];
                    for (var k = 0; k < clip.components.numItems; k++) {
                        try { cn.push(clip.components[k].displayName); } catch(e) {}
                    }
                    d.push("comps=[" + cn.join(",") + "]");
                } catch(e) {}
                lines.push(d.join(" | "));
            }
        }

        // Lista também o que tem na bin com nome parecido (adjustment layers?)
        lines.push("── Project items com 'Adjustment'/'Mister' no nome ──");
        function scanBin(item, depth) {
            if (depth > 6) return;
            try {
                for (var i = 0; i < item.children.numItems; i++) {
                    var ch = item.children[i];
                    var nm = "";
                    try { nm = ch.name; } catch(e) {}
                    if (nm && (nm.indexOf("Adjustment") >= 0 || nm.indexOf("Mister") >= 0 || nm.indexOf("Shake") >= 0 || nm.indexOf("Distort") >= 0)) {
                        var pt = "?";
                        try { pt = ch.type; } catch(e) {}
                        lines.push("  bin: '" + nm + "' type=" + pt);
                    }
                    try { if (ch.children && ch.children.numItems > 0) scanBin(ch, depth+1); } catch(e) {}
                }
            } catch(e) {}
        }
        try { scanBin(app.project.rootItem, 0); } catch(e) {}

        return JSON.stringify({ ok: true, lines: lines });
    } catch(e) {
        return JSON.stringify({ error: e.message });
    }
}

// DEBUG: dump EXAUSTIVO pra achar onde o Premiere armazena o media slot value.
// Varre TODOS os componentes do clip + várias APIs (getValue, getValueAtTime,
// getValueAtKey, XMP metadata) pra cada prop, procurando QUALQUER valor não-default
// que possa indicar a referência da imagem.
function debugReadMOGRTValues() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return JSON.stringify({ error: "Nenhuma sequência ativa" });

        var lines = [];

        // Procura primeiro MOGRT clip
        var foundClip = null;
        var foundClipPos = "";
        for (var t = 0; t < seq.videoTracks.numTracks && !foundClip; t++) {
            var track = seq.videoTracks[t];
            for (var c = 0; c < track.clips.numItems && !foundClip; c++) {
                var clip = track.clips[c];
                try {
                    if (typeof clip.getMGTComponent === "function") {
                        var mgt = clip.getMGTComponent();
                        if (mgt && mgt.properties && mgt.properties.numItems > 0) {
                            foundClip = clip;
                            foundClipPos = "V" + (t+1) + " clip " + c;
                            break;
                        }
                    }
                } catch(e) {}
            }
        }

        if (!foundClip) return JSON.stringify({ error: "Nenhum MOGRT encontrado na sequência ativa" });
        lines.push("MOGRT em " + foundClipPos + ": " + (foundClip.name || "?"));
        lines.push("");

        function readPropAllWays(prop, label) {
            var lns = [];
            var dn = "?";
            try { dn = prop.displayName || "?"; } catch(e) {}
            lns.push(label + " '" + dn + "':");

            // Tenta vários getters
            var getters = [
                ["getValue()",          function() { return prop.getValue(); }],
                ["getValueAtTime(0)",   function() { var tt = new Time(); tt.ticks = "0"; return prop.getValueAtTime(tt); }],
                ["getValueAtKey(0)",    function() { return prop.numKeys > 0 ? prop.getValueAtKey(0) : "(numKeys=0)"; }]
            ];
            for (var g = 0; g < getters.length; g++) {
                try {
                    var v = getters[g][1]();
                    var vs = "";
                    if (v === null) vs = "(null)";
                    else if (v === undefined) vs = "(undef)";
                    else if (typeof v === "object") {
                        try { vs = "obj{" + (v.constructor ? v.constructor.name : "?") + "} " + JSON.stringify(v).substring(0, 100); }
                        catch(eJ) { vs = "obj(unserializable)"; }
                    } else {
                        vs = String(v);
                        if (vs.length > 100) vs = vs.substring(0, 100) + "...";
                    }
                    lns.push("    " + getters[g][0] + " = " + vs);
                } catch(eG) {
                    lns.push("    " + getters[g][0] + " ✗ " + eG.message);
                }
            }
            return lns;
        }

        // 1. Dump TODOS os components do clip, não só MGT
        lines.push("=== TODOS COMPONENTS DO CLIP (" + foundClip.components.numItems + ") ===");
        for (var ci = 0; ci < foundClip.components.numItems; ci++) {
            var comp = foundClip.components[ci];
            var cn = "?";
            try { cn = comp.displayName || "?"; } catch(e) {}
            var mn = "?";
            try { mn = comp.matchName || "?"; } catch(e) {}
            lines.push("--- comp[" + ci + "] '" + cn + "' (matchName=" + mn + ") props=" + (comp.properties ? comp.properties.numItems : 0));
            if (comp.properties) {
                for (var pi = 0; pi < comp.properties.numItems; pi++) {
                    var lns = readPropAllWays(comp.properties[pi], "  [" + pi + "]");
                    for (var li = 0; li < lns.length; li++) lines.push(lns[li]);
                }
            }
        }

        // 2. ProjectItem do MasterClip
        try {
            var pi = foundClip.projectItem;
            if (pi) {
                lines.push("");
                lines.push("=== ProjectItem (master) ===");
                lines.push("  name: " + pi.name);
                lines.push("  nodeId: " + (pi.nodeId || "(null)"));
                lines.push("  treeNodeID: " + (pi.treeNodeID || "(null)"));
                try { lines.push("  getMediaPath(): " + pi.getMediaPath()); } catch(e) {}
                try { lines.push("  type: " + pi.type); } catch(e) {}
                // XMP metadata
                try {
                    if (typeof pi.getXMPMetadata === "function") {
                        var xmp = pi.getXMPMetadata();
                        if (xmp) lines.push("  XMP (len=" + xmp.length + "): " + xmp.substring(0, 300) + "...");
                    }
                } catch(eX) {}
                // ProjectMetadata
                try {
                    if (typeof pi.getProjectMetadata === "function") {
                        var pm = pi.getProjectMetadata();
                        if (pm) lines.push("  ProjectMeta (len=" + pm.length + "): " + pm.substring(0, 300) + "...");
                    }
                } catch(eP) {}
            }
        } catch(ePI) {}

        // 3. XMP metadata do clip-instance (não só MasterClip)
        try {
            if (typeof foundClip.getXMPMetadata === "function") {
                var clipXmp = foundClip.getXMPMetadata();
                if (clipXmp) lines.push("=== Clip XMP (len=" + clipXmp.length + ") ===\n" + clipXmp.substring(0, 500));
            }
        } catch(eCX) {}

        return JSON.stringify({ ok: true, log: lines });
    } catch(e) {
        return JSON.stringify({ error: e.message });
    }
}

// ─── MOGRT: HELPERS PRA MEDIA SLOT REPLACEMENT ──────────────────────────────

// Acha um ProjectItem existente que aponta pra esse arquivo, ou importa o
// arquivo no projeto e retorna o novo ProjectItem. Usado pra preencher
// media slots de MOGRT com imagens auto-geradas.
function findOrImportProjectItem(filePath) {
    if (!filePath) return null;
    var normalized = String(filePath).replace(/\\/g, "/");

    function searchBin(parent, depth) {
        if (depth > 6) return null;
        for (var i = 0; i < parent.children.numItems; i++) {
            var child = parent.children[i];
            try {
                var p = "";
                try { p = child.getMediaPath() || ""; } catch(eMP) {}
                if (p && p.replace(/\\/g, "/").toLowerCase() === normalized.toLowerCase()) {
                    return child;
                }
            } catch(e) {}
            if (child.children && child.children.numItems > 0) {
                var found = searchBin(child, depth + 1);
                if (found) return found;
            }
        }
        return null;
    }

    // Procura existente
    var existing = searchBin(app.project.rootItem, 0);
    if (existing) return existing;

    // Importa
    try {
        var beforeIDs = {};
        function snapshotChildren(parent, depth) {
            if (depth > 6) return;
            for (var i = 0; i < parent.children.numItems; i++) {
                var c = parent.children[i];
                beforeIDs[c.nodeId || c.name] = true;
                if (c.children && c.children.numItems > 0) snapshotChildren(c, depth + 1);
            }
        }
        snapshotChildren(app.project.rootItem, 0);

        app.project.importFiles([filePath], 1, app.project.rootItem, 0);

        // Acha o novo item (diff)
        function findNew(parent, depth) {
            if (depth > 6) return null;
            for (var i = 0; i < parent.children.numItems; i++) {
                var c = parent.children[i];
                if (!beforeIDs[c.nodeId || c.name]) {
                    // Verifica se aponta pro arquivo importado
                    try {
                        var p = c.getMediaPath() || "";
                        if (p.replace(/\\/g, "/").toLowerCase() === normalized.toLowerCase()) return c;
                    } catch(e) {}
                }
                if (c.children && c.children.numItems > 0) {
                    var f = findNew(c, depth + 1);
                    if (f) return f;
                }
            }
            return null;
        }
        var newItem = findNew(app.project.rootItem, 0);
        if (newItem) return newItem;
    } catch(eImp) {}

    // Última tentativa: re-procura por path (importFiles pode ter levado um instante)
    return searchBin(app.project.rootItem, 0);
}

// Substitui o media slot de um clip MOGRT pelo ProjectItem fornecido.
// VERSÃO DIAGNÓSTICA: lê value antes/depois pra confirmar troca real,
// testa MUITAS abordagens diferentes pra descobrir qual REALMENTE muda
// a mídia visualmente (não só "OK" sem efeito).
function setMOGRTMediaSlot(clip, slotName, projectItem, logArr) {
    if (!logArr) logArr = [];
    var realApplied = false;
    var slotUsed = null;
    var mediaPath = null;
    try { mediaPath = projectItem.getMediaPath() || null; } catch(eMP) {}
    if (!mediaPath) {
        logArr.push("ERR: img path não disponível");
        return false;
    }

    // DESCOBRIMOS: o slot value é um GUID (nodeId do ProjectItem), não um path!
    // O placeholder default tem GUID 00000000-0000-... Pra trocar, precisamos
    // passar o nodeId real do ProjectItem da imagem.
    var nodeId = null;
    try { nodeId = projectItem.nodeId || null; } catch(eNI) {}
    var treeNodePath = null;
    try { treeNodePath = projectItem.treeNodeID || null; } catch(eTN) {}

    logArr.push("img path: " + mediaPath);
    logArr.push("nodeId: " + (nodeId || "(none)") + " | treeNodePath: " + (treeNodePath || "(none)"));

    // Normalizações de path pra tentar
    var paths = [
        mediaPath,                                          // como veio
        mediaPath.replace(/\\/g, "/"),                      // forward slashes
        mediaPath.replace(/\//g, "\\"),                     // backslashes
        "file:///" + mediaPath.replace(/\\/g, "/"),         // file:// URI
        "file:///" + mediaPath.replace(/\\/g, "/").replace(/^\/+/, "")
    ];

    // Lê valor da prop com fallback
    function readVal(prop) {
        try {
            var v = prop.getValue();
            if (v === null || v === undefined) return "(null)";
            return String(v).substring(0, 60);
        } catch(e) { return "(err: " + e.message + ")"; }
    }

    function tryProp(prop, srcDesc) {
        if (realApplied) return;
        var dn = "?";
        try { dn = prop.displayName || "?"; } catch(eN) {}
        if (slotName && dn !== slotName) return;

        var before = readVal(prop);
        logArr.push(srcDesc + " '" + dn + "' BEFORE: " + before);

        // Lista de tentativas (label, função). PRIORIDADE: nodeId primeiro
        // (descoberto: slot value é GUID do ProjectItem, não path).
        var attempts = [
            ["setValue(nodeId)",        function() { if (!nodeId) throw new Error("no nodeId"); prop.setValue(nodeId); }],
            ["setValue(nodeId, true)",  function() { if (!nodeId) throw new Error("no nodeId"); prop.setValue(nodeId, true); }],
            ["setValue(treeNodePath)",  function() { if (!treeNodePath) throw new Error("no treeNodePath"); prop.setValue(treeNodePath); }],
            ["setValue(projectItem)",   function() { prop.setValue(projectItem); }],
            ["setValue(pi, true)",      function() { prop.setValue(projectItem, true); }],
            ["setValue(path)",          function() { prop.setValue(mediaPath); }],
            ["setValue(path, true)",    function() { prop.setValue(mediaPath, true); }],
            ["setValueAtKey(0,nodeId,true)", function() { if (!nodeId) throw new Error("no nodeId"); prop.setValueAtKey(0, nodeId, true); }],
            ["setValueAtKey(0,pi,true)",     function() { prop.setValueAtKey(0, projectItem, true); }]
        ];

        // Função que valida se a mudança é "real" (não só armazenou string)
        // Critério: o novo valor deve PARECER um GUID válido (não placeholder zero)
        // OU deve ser diferente do BEFORE de uma forma que indica match com ProjectItem
        function isValidChange(before, after) {
            if (before === after) return false;
            // Se after parece GUID (formato 8-4-4-4-12 hex), provavelmente é válido
            if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(after)) {
                return after !== "00000000-0000-0000-0000-000000000000";
            }
            // Se after é um path (contém / ou \), pode ser que o Premiere armazenou mas
            // não vai resolver corretamente — não consideramos válido sem testar visual
            if (after.indexOf("\\") >= 0 || after.indexOf("/") >= 0) {
                return false; // path-format = provavelmente NÃO resolve a mídia
            }
            return true; // mudou pra algo não-default, consideramos válido
        }

        for (var a = 0; a < attempts.length; a++) {
            var name = attempts[a][0];
            var fn   = attempts[a][1];
            try {
                fn();
                var after = readVal(prop);
                var changed = (after !== before);
                var valid   = isValidChange(before, after);
                logArr.push("  " + name + " → AFTER: " + after + " " +
                            (valid ? "✓ VALID" : (changed ? "△ changed-but-invalid" : "× same")));
                if (valid) {
                    realApplied = true;
                    slotUsed = dn + " via " + name;
                    return;
                }
            } catch(eFn) {
                logArr.push("  " + name + " ✗ " + eFn.message);
            }
        }
    }

    // Abordagem 1: getMGTComponent (preferencial)
    try {
        if (typeof clip.getMGTComponent === "function") {
            var mgt = clip.getMGTComponent();
            if (mgt && mgt.properties) {
                logArr.push("MGT comp: " + mgt.properties.numItems + " props");
                for (var i = 0; i < mgt.properties.numItems && !realApplied; i++) {
                    tryProp(mgt.properties[i], "MGT[" + i + "]");
                }
            }
        }
    } catch(eM) {}

    // Abordagem 2: walk clip.components (fallback) — só se a MGT falhar
    if (!realApplied) {
        try {
            for (var c = 0; c < clip.components.numItems && !realApplied; c++) {
                var comp = clip.components[c];
                if (comp.properties && comp.properties.numItems > 0) {
                    for (var p2 = 0; p2 < comp.properties.numItems && !realApplied; p2++) {
                        tryProp(comp.properties[p2], "comp[" + c + "]");
                    }
                }
            }
        } catch(eC) {}
    }

    // Abordagem 3: métodos no clip diretamente
    if (!realApplied) {
        var clipMethods = ["replaceMedia", "setMogrtMediaRef", "replaceClipMedia",
                           "setSourceMedia", "replaceFootage"];
        for (var cm = 0; cm < clipMethods.length && !realApplied; cm++) {
            var m = clipMethods[cm];
            if (typeof clip[m] === "function") {
                try {
                    clip[m](projectItem);
                    realApplied = true;
                    slotUsed = "clip." + m;
                    logArr.push("clip." + m + "(pi) ✓ OK");
                } catch(eClipM) {
                    logArr.push("clip." + m + " ✗ " + eClipM.message);
                }
            }
        }
    }

    if (realApplied) {
        logArr.push("FINAL: " + slotUsed + " = " + mediaPath.split(/[\\\/]/).pop());
    } else {
        logArr.push("FALHOU: nenhuma tentativa realmente trocou a mídia (img: " + mediaPath + ")");
    }
    return realApplied;
}

// Insere um MOGRT na timeline e substitui seu media slot pela imagem fornecida.
// Usado pra envelopar imagens auto-fill em MOGRTs de zoom (ZOOMIN/ZOOMOUT).
//
// mogrtName: ex "ZOOMIN" (procura [TEMPLATE]ZOOMIN no projeto)
// imagePath: caminho absoluto da imagem .png/.jpg
// slotName: nome do slot dentro do MOGRT (null = primeiro slot encontrado)
// startSec, durationSec: timing na main timeline
// trackIndex: índice da track destino
function insertMOGRTWithImage(mogrtName, imagePath, slotName, startSec, durationSec, trackIndex) {
    var updateLog = [];
    try {
        var mainSeq = app.project.activeSequence;
        if (!mainSeq) return JSON.stringify({ error: "Nenhuma sequência ativa." });

        // 1. Acha o MOGRT MasterClip
        var mogrtItem = findTemplateProjectItem(mogrtName);
        if (!mogrtItem) {
            return JSON.stringify({
                error: "MOGRT não encontrado: [TEMPLATE]" + mogrtName +
                       ". Importe o .mogrt no Premiere, drag pra bin, renomeie pra [TEMPLATE]" + mogrtName,
                updateLog: updateLog
            });
        }
        updateLog.push("MOGRT: '" + mogrtItem.name + "' encontrado");

        // 2. Acha ou importa a imagem
        var imageItem = findOrImportProjectItem(imagePath);
        if (!imageItem) {
            return JSON.stringify({
                error: "Imagem não encontrada/importada: " + imagePath,
                updateLog: updateLog
            });
        }
        updateLog.push("IMG: '" + imageItem.name + "' (" + imagePath + ")");

        // 3. Insere MOGRT na timeline
        var track = ensureVideoTrack(mainSeq, trackIndex);
        var time = new Time();
        time.ticks = toTicks(startSec);

        try {
            track.overwriteClip(mogrtItem, time);
        } catch(eOver) {
            return JSON.stringify({
                error: "overwriteClip falhou: " + eOver.message,
                updateLog: updateLog
            });
        }

        // 4. Localiza o clip inserido
        var TPS = 254016000000;
        var startTicks = parseFloat(toTicks(startSec));
        var insertedClip = null;
        for (var nci = track.clips.numItems - 1; nci >= 0; nci--) {
            var cand = track.clips[nci];
            var cs = 0;
            try { cs = parseFloat(cand.start.ticks); } catch(eCS) {}
            if (Math.abs(cs - startTicks) < TPS) {
                insertedClip = cand;
                break;
            }
        }
        if (!insertedClip) {
            updateLog.push("WARN: clip inserido não localizado pra subst de media slot");
            return JSON.stringify({ success: true, mogrt: true, updateLog: updateLog });
        }

        // 5. Ajusta duração se especificada (durationSec)
        if (durationSec && durationSec > 0) {
            try {
                var newEnd = new Time();
                newEnd.ticks = String(startTicks + (durationSec * TPS));
                insertedClip.end = newEnd;
            } catch(eDur) {
                updateLog.push("duration adj err: " + eDur.message);
            }
        }

        // 6. Substitui o media slot
        var slotLog = [];
        var slotOk = setMOGRTMediaSlot(insertedClip, slotName, imageItem, slotLog);
        if (slotOk) {
            updateLog.push("MEDIA SLOT ✓ substituído");
        } else {
            updateLog.push("MEDIA SLOT ✗ falhou");
        }
        for (var sl = 0; sl < slotLog.length; sl++) updateLog.push("  " + slotLog[sl]);

        return JSON.stringify({
            success: true, mogrt: true, mediaReplaced: slotOk,
            updateLog: updateLog
        });
    } catch(e) {
        return JSON.stringify({ error: e.message, updateLog: updateLog });
    }
}

// Substitui o texto de um clip Essential Graphics
// Tenta múltiplos caminhos de propriedade pois a API não é plenamente documentada
function setClipText(clip, newText, debugLog, placeholder, product) {
    // Nomes possíveis da propriedade de texto (varia por versão/locale)
    var textPropNames = ["Source Text", "Text", "Texto", "text",
                         "Texto de origem", "Texto de Origem", "sourceText"];

    function trySetProp(prop) {
        var dn = prop.displayName || "?";
        var numKeys = 0;
        try { numKeys = prop.numKeys || 0; } catch(e) {}

        var rawVal = null;
        var rawType = "?";
        try {
            rawVal = prop.getValue();
            rawType = typeof rawVal;
        } catch(eGet) {}
        if (debugLog) debugLog.push("    prop='" + dn + "' keys=" + numKeys + " rawType=" + rawType);

        // ── D: objeto TextDocument — altera .text preservando estilo ─────────────
        if (rawVal !== null && rawVal !== undefined && rawType === "object") {
            try {
                var tdBefore = "?";
                try { tdBefore = String(rawVal.text).substring(0, 20); } catch(e) {}
                if (debugLog) debugLog.push("    D: td.text antes='" + tdBefore + "'");
                rawVal.text = newText;
                prop.setValue(rawVal, true);
                if (debugLog) debugLog.push("    → D:td.text ok");
                return true;
            } catch (eD) {
                if (debugLog) debugLog.push("    D err: " + eD.message);
            }
        }

        // ── D2: tenta .text mesmo quando rawType="string" (ExtendScript mis-typing) ─
        // Em algumas versões do Premiere o objeto nativo TextDocument aparece como "string"
        try {
            if (rawVal !== null && rawVal !== undefined) {
                var tdTextD2 = rawVal.text;
                if (typeof tdTextD2 === "string") {
                    if (debugLog) debugLog.push("    D2: .text='" + tdTextD2.substring(0, 30) + "'");
                    rawVal.text = newText;
                    prop.setValue(rawVal, true);
                    if (debugLog) debugLog.push("    → D2:td.text ok");
                    return true;
                } else {
                    if (debugLog) debugLog.push("    D2: .text indisponível (type=" + typeof tdTextD2 + ")");
                }
            }
        } catch(eD2) {
            if (debugLog) debugLog.push("    D2 err: " + eD2.message);
        }

        // ── F: addKey → getValueAtKey → modifica .text → setValueAtKey ───────────
        // Alguns props retornam TextDocument apenas quando acessados via keyframe
        try {
            var t0F = new Time(); t0F.ticks = "0";
            try { prop.addKey(t0F); } catch(eAddF) {}
            if (prop.numKeys > 0) {
                var kvF = prop.getValueAtKey(0);
                if (debugLog) debugLog.push("    F: kvF type=" + typeof kvF +
                    " kvF.text=" + (kvF ? typeof kvF.text : "n/a"));
                if (kvF && typeof kvF.text === "string") {
                    kvF.text = newText;
                    prop.setValueAtKey(t0F, kvF, true);
                    if (debugLog) debugLog.push("    → F:kvF.text ok");
                    return true;
                }
                // F2: tenta setar TextDocument via setValueAtKey (em vez de string)
                try {
                    var newTDF = new TextDocument(newText);
                    prop.setValueAtKey(t0F, newTDF, true);
                    if (debugLog) debugLog.push("    → F2:setValueAtKey(TextDoc) ok");
                    return true;
                } catch(eF2) {
                    if (debugLog) debugLog.push("    F2 err: " + eF2.message);
                }
            }
        } catch(eF) {
            if (debugLog) debugLog.push("    F err: " + eF.message);
        }

        // ── E: substituição binária ────────────────────────────────────────────────
        // getValue() pode retornar string binária com TextDocument serializado.
        // O placeholder aparece como ASCII ou UTF-16LE dentro do blob binário.
        // Substitui o texto e tenta corrigir campo de comprimento (int32 LE) se presente.
        if (rawType === "string") {
            try {
                var t0E = new Time(); t0E.ticks = "0";
                try { prop.addKey(t0E); } catch(eAddE) {}

                var binVal = rawVal;
                if (prop.numKeys > 0) {
                    try {
                        var kvE = prop.getValueAtKey(prop.numKeys - 1);
                        if (kvE !== null && kvE !== undefined) binVal = kvE;
                    } catch(eKV) {}
                }

                var binStr = String(binVal);
                if (debugLog) debugLog.push("    E: binStr len=" + binStr.length +
                    " preview='" + binStr.substring(0, 80).replace(/[^\x20-\x7E]/g, "?") + "'");

                // ── E1: busca ASCII [[...]] ────────────────────────────────────────
                var bracketStart = binStr.indexOf("[[");
                if (bracketStart >= 0) {
                    var bracketEnd = binStr.indexOf("]]", bracketStart);
                    if (bracketEnd >= 0) {
                        var foundPlaceholder = binStr.substring(bracketStart, bracketEnd + 2);
                        var phLen = foundPlaceholder.length;
                        var ntLen = newText.length;

                        // Diagnóstico: 6 bytes antes de [[
                        if (debugLog) {
                            var hexPre = "";
                            for (var hb = Math.max(0, bracketStart - 6); hb < bracketStart; hb++) {
                                var hc = binStr.charCodeAt(hb);
                                hexPre += (hc < 16 ? "0" : "") + hc.toString(16) + " ";
                            }
                            debugLog.push("    E1: found='" + foundPlaceholder + "' hex6_antes=[" + hexPre.replace(/\s+$/,"") + "]");
                        }

                        var modifiedBin = binStr.split(foundPlaceholder).join(newText);

                        // Tenta corrigir campo de comprimento int32-LE imediatamente antes de [[
                        if (phLen !== ntLen && bracketStart >= 4) {
                            var lenField = binStr.charCodeAt(bracketStart - 4) |
                                          (binStr.charCodeAt(bracketStart - 3) << 8) |
                                          (binStr.charCodeAt(bracketStart - 2) << 16) |
                                          (binStr.charCodeAt(bracketStart - 1) << 24);
                            if (lenField === phLen) {
                                var newLenBytes = String.fromCharCode(
                                    ntLen & 0xFF, (ntLen >> 8) & 0xFF,
                                    (ntLen >> 16) & 0xFF, (ntLen >> 24) & 0xFF);
                                modifiedBin = modifiedBin.substring(0, bracketStart - 4) +
                                              newLenBytes +
                                              modifiedBin.substring(bracketStart);
                                if (debugLog) debugLog.push("    E1: corrigiu campo len " + phLen + "→" + ntLen);
                            } else {
                                if (debugLog) debugLog.push("    E1: campo len check: " + lenField + " ≠ " + phLen);
                            }
                        }

                        prop.setValue(modifiedBin, true);
                        if (debugLog) debugLog.push("    → E1:bin replace '" + foundPlaceholder + "' → '" + newText + "'");
                        return true;
                    } else {
                        if (debugLog) debugLog.push("    E1: [[ encontrado mas ]] não");
                    }
                } else {
                    if (debugLog) debugLog.push("    E1: [[ não encontrado em ASCII");
                }

                // ── E2: busca UTF-16LE ─────────────────────────────────────────────
                // Cada char ASCII vira [char]\x00 no UTF-16LE
                var phNames = [
                    "[[PRODUCT_PRICE_MIN]]", "[[PRODUCT_PRICE_MAX]]",
                    "[[PRODUCT_NAME]]",      "[[PRODUCT_BRAND]]",
                    "[[PRODUCT_PRICE]]",     "[[PRODUCT_IMAGE]]"
                ];
                for (var ph = 0; ph < phNames.length; ph++) {
                    var ph16 = "";
                    for (var uc = 0; uc < phNames[ph].length; uc++) {
                        ph16 += phNames[ph][uc] + "\x00";
                    }
                    var utf16pos = binStr.indexOf(ph16);
                    if (utf16pos >= 0) {
                        if (debugLog) debugLog.push("    E2: '" + phNames[ph] + "' UTF-16LE @ " + utf16pos);
                        var nt16 = "";
                        for (var nc = 0; nc < newText.length; nc++) { nt16 += newText[nc] + "\x00"; }
                        var modBin16 = binStr.substring(0, utf16pos) + nt16 + binStr.substring(utf16pos + ph16.length);
                        // Tenta corrigir campo de comprimento
                        if (utf16pos >= 4) {
                            var lf16 = binStr.charCodeAt(utf16pos - 4) |
                                       (binStr.charCodeAt(utf16pos - 3) << 8) |
                                       (binStr.charCodeAt(utf16pos - 2) << 16) |
                                       (binStr.charCodeAt(utf16pos - 1) << 24);
                            if (lf16 === phNames[ph].length) {
                                var newLB16 = String.fromCharCode(
                                    newText.length & 0xFF, (newText.length >> 8) & 0xFF,
                                    (newText.length >> 16) & 0xFF, (newText.length >> 24) & 0xFF);
                                modBin16 = modBin16.substring(0, utf16pos - 4) + newLB16 + modBin16.substring(utf16pos);
                                if (debugLog) debugLog.push("    E2: corrigiu len16 " + phNames[ph].length + "→" + newText.length);
                            }
                        }
                        prop.setValue(modBin16, true);
                        if (debugLog) debugLog.push("    → E2:UTF16 replace ok");
                        return true;
                    }
                }
                if (debugLog) debugLog.push("    E2: nenhum placeholder encontrado em UTF-16LE");

            } catch (eE) {
                if (debugLog) debugLog.push("    E err: " + eE.message);
            }
        }

        // ── A: new TextDocument (perde estilo, último recurso) ────────────────────
        try {
            var newTD = new TextDocument(newText);
            prop.setValue(newTD, true);
            if (debugLog) debugLog.push("    → A:new TextDocument ok");
            return true;
        } catch (eA) {
            if (debugLog) debugLog.push("    A err: " + eA.message);
        }

        // ── C: setValue string direta ─────────────────────────────────────────────
        try {
            prop.setValue(newText, true);
            if (debugLog) debugLog.push("    → C:setValue string ok");
            return true;
        } catch (eC) {
            if (debugLog) debugLog.push("    C err: " + eC.message);
        }

        return false;
    }

    function searchProps(propsCollection) {
        for (var i = 0; i < propsCollection.numItems; i++) {
            var prop = propsCollection[i];
            var dn = prop.displayName || "";
            for (var n = 0; n < textPropNames.length; n++) {
                if (dn === textPropNames[n]) {
                    if (trySetProp(prop)) return true;
                }
            }
            if (prop.properties && prop.properties.numItems > 0) {
                if (searchProps(prop.properties)) return true;
            }
        }
        return false;
    }

    try {
        for (var i = 0; i < clip.components.numItems; i++) {
            var comp = clip.components[i];
            if (debugLog) debugLog.push("  comp[" + i + "]: '" + (comp.displayName || "?") + "' props=" + (comp.properties ? comp.properties.numItems : 0));
            if (comp.properties && comp.properties.numItems > 0) {
                if (searchProps(comp.properties)) return true;
            }
        }
    } catch (e) {
        if (debugLog) debugLog.push("  setClipText erro: " + e.message);
    }

    return false;
}

// Substitui um clip marcador (adjustment layer ou qualquer placeholder)
// pela imagem real, mantendo posição e duração originais
// Captura propriedades visuais (Motion + Opacity) de um clip, incluindo keyframes.
// Usado pra preservar transformações/animações do placeholder ao substituí-lo pela imagem.
// Retorna { components: { "Motion": { props: { "Scale": {...}, ... } }, "Opacity": {...} } }
function captureClipMotion(clip) {
    var data = { components: {} };
    if (!clip || !clip.components) return data;
    var componentNames = ["Motion", "Movimento", "Opacity", "Opacidade"];
    try {
        for (var c = 0; c < clip.components.numItems; c++) {
            var comp = clip.components[c];
            var cname = comp.displayName || "";
            var isRelevant = false;
            for (var cn = 0; cn < componentNames.length; cn++) {
                if (cname === componentNames[cn]) { isRelevant = true; break; }
            }
            if (!isRelevant) continue;

            var compData = { props: {} };
            if (!comp.properties) continue;
            for (var p = 0; p < comp.properties.numItems; p++) {
                var prop = comp.properties[p];
                var pname = prop.displayName || "";
                var pdata = { isTimeVarying: false };

                try { pdata.isTimeVarying = prop.isTimeVarying(); } catch(eTV) {}

                if (pdata.isTimeVarying) {
                    pdata.keys = [];
                    try {
                        var keysArr = prop.getKeys();
                        if (keysArr && keysArr.length) {
                            for (var k = 0; k < keysArr.length; k++) {
                                var tk = keysArr[k];
                                if (!tk || tk.ticks === undefined) continue;
                                var vk = null;
                                try { vk = prop.getValueAtKey(tk); } catch(eGV) {}
                                pdata.keys.push({ ticks: String(tk.ticks), value: vk });
                            }
                        }
                    } catch(eK) {}
                } else {
                    try { pdata.value = prop.getValue(); } catch(eV) {}
                }

                compData.props[pname] = pdata;
            }
            data.components[cname] = compData;
        }
    } catch(eC) {}
    return data;
}

// Aplica propriedades visuais capturadas em um clip. Mantém defaults pra Scale=100
// estático (assim scale-to-frame não é sobrescrito por placeholder com Scale default).
// Keyframes SEMPRE são aplicados (animação do placeholder transfere pra imagem).
function applyClipMotion(clip, data) {
    if (!data || !data.components || !clip || !clip.components) return;
    try {
        for (var c = 0; c < clip.components.numItems; c++) {
            var comp = clip.components[c];
            var cname = comp.displayName || "";
            var compData = data.components[cname];
            if (!compData || !compData.props) continue;
            if (!comp.properties) continue;

            for (var p = 0; p < comp.properties.numItems; p++) {
                var prop = comp.properties[p];
                var pname = prop.displayName || "";
                var pdata = compData.props[pname];
                if (!pdata) continue;

                // NUNCA transferir Blend Mode: placeholders/adjustment layers comumente
                // usam blend modes especiais (Color, Overlay, etc) que destruiriam o
                // visual da imagem normal. Image sempre deve ficar em Normal blend.
                if (pname === "Blend Mode" || pname === "Modo de mesclagem" ||
                    pname === "Modo de Mesclagem" || pname === "Mistura") {
                    continue;
                }

                if (pdata.isTimeVarying && pdata.keys && pdata.keys.length > 0) {
                    // Aplica TODAS as keyframes (animação preservada)
                    try { prop.setTimeVarying(true); } catch(eTV) {}
                    for (var k = 0; k < pdata.keys.length; k++) {
                        var kf = pdata.keys[k];
                        var t = new Time();
                        t.ticks = String(kf.ticks);
                        try { prop.addKey(t); } catch(eAdd) {}
                        try { prop.setValueAtKey(t, kf.value, true); } catch(eSet) {}
                    }
                } else if (pdata.value !== undefined && pdata.value !== null) {
                    // Static: skip Scale=100 default (deixa scale-to-frame agir)
                    var isMotionScale = (cname === "Motion" || cname === "Movimento") &&
                                        (pname === "Scale" || pname === "Escala");
                    if (isMotionScale && pdata.value === 100) continue;
                    // Skip Opacity=100 default também
                    var isOpacityProp = (cname === "Opacity" || cname === "Opacidade") &&
                                        (pname === "Opacity" || pname === "Opacidade");
                    if (isOpacityProp && pdata.value === 100) continue;
                    try { prop.setValue(pdata.value, true); } catch(eV) {}
                }
            }
        }
    } catch(eA) {}
}

function replaceClipWithImage(track, clip, imagePath, hintSrcW, hintSrcH) {
    try {
        var startTime = new Time();
        startTime.ticks = clip.start.ticks;

        var endTime = new Time();
        endTime.ticks = clip.end.ticks;

        var durationSec = (parseFloat(endTime.ticks) - parseFloat(startTime.ticks)) / TICKS_PER_SECOND;

        // Captura Motion + Opacity do placeholder ANTES de removê-lo, pra preservar
        // transformações estáticas (Position, Rotation, etc) e animações (keyframes)
        // ao aplicar na imagem que vai substituí-lo.
        var capturedMotion = captureClipMotion(clip);

        clip.remove(false, false);

        var item = importAndGet(imagePath);
        if (!item) return false;

        track.overwriteClip(item, startTime);

        // Localiza o clip recém-inserido e ajusta duração (acha o mais próximo)
        var newClipRef = null;
        var bestRefDiff = Infinity;
        var startTarget = parseFloat(startTime.ticks);
        for (var c = 0; c < track.clips.numItems; c++) {
            var newClip = track.clips[c];
            if (!newClip || !newClip.start) continue;
            var diffR = Math.abs(parseFloat(newClip.start.ticks) - startTarget);
            if (diffR < bestRefDiff) {
                bestRefDiff = diffR;
                newClipRef = newClip;
            }
        }
        if (newClipRef && bestRefDiff < 254016000000) {
            newClipRef.end = endTime;
        } else {
            newClipRef = null;
        }

        // Aplica "Scale to Frame Size" no PNG do produto inserido
        // (precisa descobrir qual sequência é dona dessa track)
        var sfInfo = null;
        try {
            var ownerSeq = null;
            for (var si = 0; si < app.project.sequences.numSequences; si++) {
                var sq = app.project.sequences[si];
                for (var ti = 0; ti < sq.videoTracks.numTracks; ti++) {
                    if (sq.videoTracks[ti] === track) { ownerSeq = sq; break; }
                }
                if (ownerSeq) break;
            }
            if (ownerSeq) sfInfo = applyScaleToFrameSize(ownerSeq, track, startTime.ticks, hintSrcW, hintSrcH);
        } catch(eSF) { sfInfo = { method: "err: " + eSF.message }; }

        // Aplica as propriedades capturadas do placeholder na imagem.
        // - Keyframes (animações) sempre transferem.
        // - Valores estáticos transferem EXCETO Scale=100 e Opacity=100 (defaults),
        //   pra não sobrescrever scale-to-frame com 100% padrão.
        if (newClipRef && capturedMotion) {
            try { applyClipMotion(newClipRef, capturedMotion); } catch(eAM) {}
        }

        // Anexa info ao log GLOBAL temporário pra updateTemplatePlaceholders pegar
        if (sfInfo) {
            try {
                if (!_globalScaleLog) _globalScaleLog = [];
                _globalScaleLog.push("scaleToFrame: " + sfInfo.method + (sfInfo.scale ? " (scale=" + sfInfo.scale.toFixed(1) + "%)" : ""));
                // Log do que foi capturado/aplicado
                var motionInfo = [];
                if (capturedMotion && capturedMotion.components) {
                    for (var cn in capturedMotion.components) {
                        if (!capturedMotion.components.hasOwnProperty(cn)) continue;
                        var compP = capturedMotion.components[cn].props;
                        var propsInfo = [];
                        for (var pn in compP) {
                            if (!compP.hasOwnProperty(pn)) continue;
                            var pd = compP[pn];
                            if (pd.isTimeVarying && pd.keys && pd.keys.length > 0) {
                                propsInfo.push(pn + "(" + pd.keys.length + "kf)");
                            } else if (pd.value !== undefined && pd.value !== null) {
                                // Só conta se for diferente do default
                                var isDefault = ((pn === "Scale" || pn === "Escala" || pn === "Opacity" || pn === "Opacidade") && pd.value === 100);
                                if (!isDefault) propsInfo.push(pn + "=" + pd.value);
                            }
                        }
                        if (propsInfo.length > 0) motionInfo.push(cn + ":[" + propsInfo.join(",") + "]");
                    }
                }
                if (motionInfo.length > 0) {
                    _globalScaleLog.push("placeholder motion: " + motionInfo.join(" "));
                }
            } catch(eGL) {}
        }

        return true;
    } catch (e) {
        return false;
    }
}

// Lê o valor de texto de uma propriedade (ComponentParam)
// Tenta várias abordagens porque a API varia entre MOGRT e Essential Graphics
function getPropTextValue(prop) {
    // 1. getValue() — tenta extrair texto de string ou TextDocument
    try {
        var val = prop.getValue();
        if (typeof val === "string") return val;
        if (val !== null && val !== undefined) {
            // TextDocument PPRO 2022+: tem propriedade .text
            if (typeof val.text === "string" && val.text.length > 0) return val.text;
            // Tenta método getText()
            if (typeof val.getText === "function") {
                try { var gt = val.getText(); if (typeof gt === "string" && gt.length > 0) return gt; } catch(e) {}
            }
            // Outras propriedades comuns
            if (typeof val.textContent === "string" && val.textContent.length > 0) return val.textContent;
            if (typeof val.value === "string" && val.value.length > 0) return val.value;
            // toString — funciona para alguns tipos
            var s = val.toString();
            if (s && s !== "[object Object]" && s.length < 50000) return s;
            // JSON.stringify como último recurso para extrair campos
            try {
                var js = JSON.stringify(val);
                if (js && js !== "{}") {
                    var match = js.match(/"text"\s*:\s*"([^"]+)"/);
                    if (match) return match[1];
                }
            } catch(e) {}
        }
    } catch (e) {}

    // 2. getValueAtTime(0) numérico
    try {
        var val2 = prop.getValueAtTime(0);
        if (typeof val2 === "string" && val2.length > 0) return val2;
        if (val2 !== null && val2 !== undefined) {
            if (typeof val2.text === "string" && val2.text.length > 0) return val2.text;
            var s2 = val2.toString();
            if (s2 && s2 !== "[object Object]") return s2;
        }
    } catch (e) {}

    // 3. getValueAtTime com Time object
    try {
        var t = new Time(); t.ticks = "0";
        var val3 = prop.getValueAtTime(t);
        if (typeof val3 === "string" && val3.length > 0) return val3;
        if (val3 !== null && val3 !== undefined) {
            if (typeof val3.text === "string" && val3.text.length > 0) return val3.text;
            var s3 = val3.toString();
            if (s3 && s3 !== "[object Object]") return s3;
        }
    } catch (e) {}

    // 4. Primeiro keyframe
    try {
        if (prop.numKeys > 0) {
            var k = prop.getValueAtKey(0);
            if (typeof k === "string" && k.length > 0) return k;
            if (k && typeof k.text === "string") return k.text;
        }
    } catch (e) {}

    return null;
}

// Remove prefixo "R$ " e garante sufixo ",00" — espelha priceNum() do JS
// Nota: ExtendScript (ES3) não tem String.trim() — usa regex
function priceNum(val) {
    var n = String(val || "").replace(/^R\$\s*/i, "").replace(/^\s+|\s+$/g, "");
    if (!n) return "";
    return n.indexOf(",") >= 0 ? n : n + ",00";
}

// Substitui [[PLACEHOLDER]] dentro do texto com o valor do produto.
// `extras` (opcional): mapa { "INFO": "...", "SUB-INFO": "..." } usado por LOWERTHIRD.
// Chaves em `extras` são wrapeadas como [[CHAVE]] automaticamente.
//
// Se `text` é um JSON de TextDocument do Premiere (tem "textEditValue" e
// "fontTextRunLength"), trabalha no nível do objeto pra:
//   1. Substituir só dentro do `textEditValue` (não em strings vazias ou arrays vizinhos)
//   2. Ajustar `fontTextRunLength` proporcionalmente pra preservar a estilização
//      (sem isso, só os primeiros N chars do texto novo ficam com estilo bold/itálico)
function applyTextSubstitutions(text, product, extras) {
    var pairs = [
        ["[[PRODUCT_BRAND]]",     product.brand     || ""],
        ["[[PRODUCT_NAME]]",      product.name      || ""],
        ["[[PRODUCT_PRICE_MIN]]", priceNum(product.price_min || product.price)],
        ["[[PRODUCT_PRICE_MAX]]", priceNum(product.price_max || product.price)],
        ["[[PRODUCT_PRICE]]",     priceNum(product.price)]
    ];
    if (extras) {
        for (var k in extras) {
            if (extras.hasOwnProperty(k)) {
                pairs.push(["[[" + k + "]]", String(extras[k] == null ? "" : extras[k])]);
            }
        }
    }

    // ── Caminho TextDocument-aware (preserva estilos via fontTextRunLength) ───
    // Detecta JSON TextDocument pela presença dos campos canônicos.
    var isTextDoc = (typeof text === "string"
                     && text.length > 30
                     && text.charAt(0) === "{"
                     && text.indexOf("\"textEditValue\"") >= 0
                     && text.indexOf("\"fontTextRunLength\"") >= 0);

    if (isTextDoc) {
        var td = null;
        try { td = eval("(" + text + ")"); } catch (eParse) { td = null; }
        if (td && typeof td.textEditValue === "string" &&
            td.fontTextRunLength && td.fontTextRunLength.length > 0) {
            var origText = td.textEditValue;
            var newText  = origText;
            for (var i = 0; i < pairs.length; i++) {
                if (newText.indexOf(pairs[i][0]) >= 0) {
                    newText = newText.split(pairs[i][0]).join(pairs[i][1]);
                }
            }
            if (newText === origText) return null; // nada bateu

            // Ajusta os run lengths. Caso simples (1 run): cobre toda a string.
            // Caso multi-run: distribui a diferença proporcionalmente no run que
            // contém o placeholder original (busca em qual range o `[[` cai).
            var delta = newText.length - origText.length;
            if (td.fontTextRunLength.length === 1) {
                td.fontTextRunLength[0] = newText.length;
            } else {
                // Multi-run: encontra qual run contém o primeiro `[[` do texto original
                var phIdx = origText.indexOf("[[");
                if (phIdx < 0) {
                    // sem placeholder explícito (foi substituído já?) — ajusta o último run
                    td.fontTextRunLength[td.fontTextRunLength.length - 1] += delta;
                } else {
                    var cursor = 0;
                    for (var r = 0; r < td.fontTextRunLength.length; r++) {
                        cursor += td.fontTextRunLength[r];
                        if (phIdx < cursor) {
                            td.fontTextRunLength[r] += delta;
                            break;
                        }
                    }
                }
            }
            td.textEditValue = newText;

            // Re-serializa via JSON-like (ExtendScript ES3 não tem JSON nativo
            // em todas versões — usa toSource-like manual).
            try {
                return _serializeTextDoc(td);
            } catch (eSer) {
                // Fallback: substituição plana
            }
        }
    }

    // ── Caminho plano (fallback): substitui em qualquer lugar da string ──────
    var result = text;
    var changed = false;
    for (var j = 0; j < pairs.length; j++) {
        if (result.indexOf(pairs[j][0]) >= 0) {
            result  = result.split(pairs[j][0]).join(pairs[j][1]);
            changed = true;
        }
    }
    return changed ? result : null;
}

// Serializa objeto TextDocument em formato JSON que o setValue do Premiere aceita.
// ExtendScript ES3 nem sempre tem JSON global — implementação manual mínima.
function _serializeTextDoc(td) {
    function ser(v) {
        if (v === null || v === undefined) return "null";
        if (typeof v === "boolean") return v ? "true" : "false";
        if (typeof v === "number") return String(v);
        if (typeof v === "string") {
            return '"' + v.replace(/\\/g, "\\\\")
                          .replace(/"/g, '\\"')
                          .replace(/\n/g, "\\n")
                          .replace(/\r/g, "\\r")
                          .replace(/\t/g, "\\t") + '"';
        }
        if (v instanceof Array || (v && typeof v.length === "number" && typeof v !== "string")) {
            var parts = [];
            for (var i = 0; i < v.length; i++) parts.push(ser(v[i]));
            return "[" + parts.join(",") + "]";
        }
        if (typeof v === "object") {
            var keys = [];
            for (var k in v) { if (v.hasOwnProperty(k)) keys.push(k); }
            var pairs = [];
            for (var ki = 0; ki < keys.length; ki++) {
                pairs.push('"' + keys[ki] + '":' + ser(v[keys[ki]]));
            }
            return "{" + pairs.join(",") + "}";
        }
        return "null";
    }
    return ser(td);
}

// Percorre TODAS as propriedades de um clip e substitui qualquer valor
// que contenha [[PLACEHOLDER]] — funciona com MOGRTs (Text A, Text B...)
// e com Essential Graphics padrão (Source Text)
function processClipTextProps(propsCollection, product, logArr, clipLabel, extras) {
    for (var i = 0; i < propsCollection.numItems; i++) {
        var prop = propsCollection[i];

        var currentVal = getPropTextValue(prop);
        if (currentVal && currentVal.indexOf("[[") >= 0) {
            var newVal = applyTextSubstitutions(currentVal, product, extras);
            if (newVal !== null) {
                try {
                    prop.setValue(newVal, true);
                    logArr.push(clipLabel + " [" + prop.displayName + "] ✓ " + String(newVal).substring(0, 50));
                } catch (e) {
                    logArr.push(clipLabel + " [" + prop.displayName + "] falhou: " + e.message);
                }
            }
        }

        if (prop.properties && prop.properties.numItems > 0) {
            processClipTextProps(prop.properties, product, logArr, clipLabel, extras);
        }
    }
}

// Fallback para Essential Graphics quando getPropTextValue não consegue ler o valor:
// usa o NOME DO CLIP como template de texto e escreve via setClipText
// debugLog recebe detalhes das props tentadas
function tryClipNameSubstitution(clip, clipName, product, logArr, extras) {
    var newText = applyTextSubstitutions(clipName, product, extras);
    if (newText === null) return false; // nome não tem placeholder

    var debugLog = [];
    var ok = setClipText(clip, newText, debugLog);

    if (ok) {
        logArr.push("'" + clipName + "' (nome) → '" + newText + "'");
        // Mostra detalhes para verificar qual abordagem realmente funcionou
        for (var d = 0; d < debugLog.length; d++) logArr.push("  " + debugLog[d]);
    } else {
        logArr.push("'" + clipName + "' (nome) FALHOU → tentou: '" + newText + "'");
        for (var d = 0; d < debugLog.length; d++) logArr.push("  " + debugLog[d]);
    }
    return ok;
}

// Percorre todas as faixas de vídeo da sequência template e substitui
// [[PLACEHOLDER]] encontrado no CONTEÚDO do texto ou no nome do clip (imagem/EG fallback)
//
// options.skipImage = true → não toca em clips [[PRODUCT_IMAGE]] (preserva o placeholder).
//   Útil quando aplicamos no TEMPLATE antes do clone, pra evitar que o placeholder seja
//   removido permanentemente (caso contrário, produtos 2+ não acham mais o [[PRODUCT_IMAGE]]).
// options.skipText = true → não toca em texto. Útil quando aplicamos na CÓPIA depois do
//   clone só pra fazer a troca de imagem (texto já foi substituído via mogrt na template).
function updateTemplatePlaceholders(templateSeq, product, options) {
    options = options || {};
    var skipImage = !!options.skipImage;
    var skipText  = !!options.skipText;
    var extras    = options.extraPlaceholders || null;

    var log = [];
    var textFound  = false;
    var imageFound = false;

    for (var t = 0; t < templateSeq.videoTracks.numTracks; t++) {
        var track  = templateSeq.videoTracks[t];
        var nClips = track.clips.numItems;

        for (var c = nClips - 1; c >= 0; c--) {
            var clip     = track.clips[c];
            var clipName = clip.name || "";
            var label    = "V" + (t + 1) + " '" + clipName.substring(0, 25) + "'";

            // Imagem: pelo nome do clip (adjustment layer renomeado [[PRODUCT_IMAGE]])
            if (clipName.indexOf("[[PRODUCT_IMAGE]]") >= 0) {
                if (skipImage) { continue; }
                if (product.image_transparent) {
                    _globalScaleLog = []; // reseta pra capturar info desse replace
                    var ok = replaceClipWithImage(track, clip, product.image_transparent,
                                                  product.image_transparent_w, product.image_transparent_h);
                    log.push("PRODUCT_IMAGE → " + (ok ? "ok (" + product.image_transparent + ")" : "falhou"));
                    if (_globalScaleLog && _globalScaleLog.length) {
                        for (var gs = 0; gs < _globalScaleLog.length; gs++) log.push("  " + _globalScaleLog[gs]);
                    }
                    _globalScaleLog = null;
                    imageFound = true;
                } else {
                    log.push("PRODUCT_IMAGE → ignorado (image_transparent não definido)");
                }
                continue;
            }

            if (skipText) continue;

            // ── Método primário: usa nome do clip como template (Essential Graphics) ──
            // tryClipNameSubstitution usa setClipText com Abordagens D, D2, F, E, A, C
            // É mais robusto que processClipTextProps para Essential Graphics nativos.
            var usedNameSub = false;
            if (clipName.indexOf("[[") >= 0) {
                var ok2 = tryClipNameSubstitution(clip, clipName, product, log, extras);
                if (ok2) { textFound = true; usedNameSub = true; }
            }

            // ── Método secundário: percorre propriedades (MOGRT com Text A, Text B...) ──
            // Também cobre EG se o método primário falhou.
            var before = log.length;
            if (!usedNameSub) {
                for (var i = 0; i < clip.components.numItems; i++) {
                    var comp = clip.components[i];
                    if (comp.properties && comp.properties.numItems > 0) {
                        processClipTextProps(comp.properties, product, log, label, extras);
                    }
                }
                if (log.length > before) textFound = true;
            }
        }
    }

    if (!textFound && !imageFound && !skipImage && !skipText) {
        log.push("AVISO: Nenhum [[PLACEHOLDER]] encontrado. Coloque os placeholders como texto nas camadas ou no nome do clip.");
    }

    return log;
}

// Salva propriedades de texto em uma sequência para restauração posterior.
// Captura dois tipos:
//   1. "Source Text" (EG nativo): getValue() retorna binário de 1 byte — inutilizável.
//      Usamos o NOME do clip como restoreText (ex: "[[PRODUCT_PRICE_MIN]]"),
//      já que o clip é nomeado com o mesmo placeholder que é seu conteúdo.
//   2. Propriedades de MOGRT (Text A, Text B…): getPropTextValue retorna JSON com [[...]]
//      que getValue() também retorna diretamente — salva e restaura esse valor raw.
function saveSourceTextValues(seq) {
    var saved = [];
    for (var t = 0; t < seq.videoTracks.numTracks; t++) {
        var track = seq.videoTracks[t];
        for (var c = 0; c < track.clips.numItems; c++) {
            var clip = track.clips[c];
            for (var ci = 0; ci < clip.components.numItems; ci++) {
                var comp = clip.components[ci];
                if (!comp.properties) continue;
                for (var pi = 0; pi < comp.properties.numItems; pi++) {
                    var prop = comp.properties[pi];
                    var dn = prop.displayName || "";

                    if (dn === "Source Text") {
                        // EG Source Text: APENAS salva clips de placeholder (nome contém [[).
                        // Clips estáticos (ex: "R$" prefixo) NÃO devem ser salvos/restaurados —
                        // a restauração usaria clip.name como texto, corrompendo o conteúdo
                        // estático (após produto 1 o R$ vira "Layer X" ou vazio).
                        var clipNameForCheck = clip.name || "";
                        if (clipNameForCheck.indexOf("[[") < 0) {
                            continue; // texto estático, deixa intocado
                        }
                        var rawEG = null;
                        try { rawEG = prop.getValue(); } catch(eEG) {}
                        saved.push({
                            prop: prop,
                            val: rawEG,
                            restoreText: clipNameForCheck, // ex: "[[PRODUCT_PRICE_MIN]]"
                            clipName: clipNameForCheck,
                            propName: dn
                        });
                    } else {
                        // MOGRT (Text A, Text B…): salva o raw getValue() se o texto tem [[...]]
                        var textVal = getPropTextValue(prop);
                        if (textVal && textVal.indexOf("[[") >= 0) {
                            var rawMG = null;
                            try { rawMG = prop.getValue(); } catch(eMG) {}
                            if (rawMG !== null && rawMG !== undefined) {
                                saved.push({
                                    prop: prop,
                                    val: rawMG,
                                    restoreText: null,
                                    clipName: clip.name || "",
                                    propName: dn
                                });
                            }
                        }
                    }
                }
            }
        }
    }
    return saved;
}

// Restaura os valores salvos por saveSourceTextValues.
//   • "Source Text" (EG nativo): usa restoreText (nome do clip = o placeholder original).
//     Não usamos o val raw de 1 byte — restaurar 1 byte corromperia o TextDocument.
//   • MOGRT (Text A, Text B…): usa val raw salvo pelo getValue().
function restoreSourceTextValues(saved) {
    for (var i = 0; i < saved.length; i++) {
        var sv = saved[i];
        if (sv.propName === "Source Text") {
            // Restaura EG Source Text com o nome do clip (= placeholder original)
            if (sv.restoreText && sv.restoreText.length > 0) {
                try { sv.prop.setValue(sv.restoreText, true); } catch(eR) {}
            }
        } else {
            // Restaura MOGRT param com o valor raw original
            if (sv.val !== null && sv.val !== undefined) {
                try { sv.prop.setValue(sv.val, true); } catch(eR2) {}
            }
        }
    }
}

// Cria (ou reutiliza) uma bin para as sequências geradas automaticamente
function getOrCreateBin(binName) {
    var root = app.project.rootItem;
    for (var i = 0; i < root.children.numItems; i++) {
        if (root.children[i].name === binName) return root.children[i];
    }
    return root.createBin(binName);
}

// Cria uma cópia independente de uma sequência template para um produto específico
// logArr recebe detalhes do processo para debug
function createProductSequenceCopy(templateSeq, copyName, logArr) {
    if (!logArr) logArr = [];

    // Reutiliza se já existe
    var n = app.project.sequences.numSequences;
    for (var i = 0; i < n; i++) {
        if (app.project.sequences[i].name === copyName) {
            logArr.push("Cópia já existe: " + copyName);
            return app.project.sequences[i];
        }
    }

    var newSeq = null;
    var savedActiveSeq = null;

    // ── Helper: captura sequência nova que apareceu ──────────────────────────
    function captureNewSeq(beforeIDs) {
        for (var fi = 0; fi < app.project.sequences.numSequences; fi++) {
            var s = app.project.sequences[fi];
            if (!beforeIDs[s.sequenceID]) return s;
        }
        return null;
    }

    function snapshotIDs() {
        var ids = {};
        for (var bi = 0; bi < app.project.sequences.numSequences; bi++) {
            ids[app.project.sequences[bi].sequenceID] = true;
        }
        return ids;
    }

    // ── Tentativa 1: métodos diretos no objeto Sequence ─────────────────────
    var seqMethods = [];
    try { for (var k in templateSeq) { if (typeof templateSeq[k] === "function") seqMethods.push(k); } } catch(e) {}
    if (seqMethods.length > 0) logArr.push("Seq.methods: " + seqMethods.slice(0, 15).join(", "));

    var seqDupCandidates = ["clone", "copy", "duplicate", "duplicateSequence"];
    for (var sd = 0; sd < seqDupCandidates.length && !newSeq; sd++) {
        var mName = seqDupCandidates[sd];
        if (typeof templateSeq[mName] !== "function") continue;
        var ids0 = snapshotIDs();
        try {
            templateSeq[mName](); // ignora retorno — pode ser objeto inútil
            // Verifica se uma sequência REAL apareceu no projeto
            newSeq = captureNewSeq(ids0);
            if (newSeq) logArr.push("Seq." + mName + "() → criou: " + newSeq.name);
            else logArr.push("Seq." + mName + "() → sem nova sequência no projeto");
        } catch(e) { logArr.push("Seq." + mName + "() err: " + e.message); }
    }

    // ── Tentativa 2: QE DOM ──────────────────────────────────────────────────
    if (!newSeq) {
        try {
            app.enableQE();
            savedActiveSeq = app.project.activeSequence;
            app.project.activeSequence = templateSeq;

            var qeSeq = null;
            try {
                qeSeq = qe.project.getActiveSequence();
                logArr.push("QE: getActiveSequence: " + (qeSeq ? "ok" : "null"));
            } catch(e) { logArr.push("QE: getActiveSequence err: " + e.message); }

            if (qeSeq) {
                // Enumera métodos disponíveis (diagnóstico)
                var qeMethods = [];
                try { for (var qk in qeSeq) { if (typeof qeSeq[qk] === "function") qeMethods.push(qk); } } catch(e) {}
                if (qeMethods.length > 0) logArr.push("QE: métodos: " + qeMethods.slice(0, 20).join(", "));

                var qeDupCandidates = ["duplicate", "clone", "copy", "duplicateSequence",
                                       "duplicateWithName", "createCopy", "copySequence"];
                for (var qd = 0; qd < qeDupCandidates.length && !newSeq; qd++) {
                    var qm = qeDupCandidates[qd];
                    if (typeof qeSeq[qm] !== "function") continue;
                    var ids1 = snapshotIDs();
                    try {
                        if (qm === "duplicateWithName") qeSeq[qm](copyName);
                        else qeSeq[qm](); // ignora retorno
                        newSeq = captureNewSeq(ids1); // verifica se apareceu no projeto
                        if (newSeq) logArr.push("QE: " + qm + "() → criou: " + newSeq.name);
                        else logArr.push("QE: " + qm + "() → sem nova sequência no projeto");
                    } catch(e) { logArr.push("QE: " + qm + "() err: " + e.message); }
                }
            }
        } catch(e) {
            logArr.push("QE: erro geral: " + e.message);
        } finally {
            if (savedActiveSeq) { try { app.project.activeSequence = savedActiveSeq; } catch(e) {} }
        }
    }

    // ── Tentativa 3: app.executeCommand (Duplicate) ──────────────────────────
    if (!newSeq) {
        try {
            savedActiveSeq = app.project.activeSequence;
            app.project.activeSequence = templateSeq;
            // Tenta IDs de comando conhecidos do Premiere Pro para "Duplicate"
            var cmdIds = [2290, 58392, 2015, 3016, 40022];
            for (var ci = 0; ci < cmdIds.length && !newSeq; ci++) {
                var ids2 = snapshotIDs();
                try {
                    app.executeCommand(cmdIds[ci]);
                    newSeq = captureNewSeq(ids2);
                    if (newSeq) logArr.push("executeCommand(" + cmdIds[ci] + ") → criou: " + newSeq.name);
                } catch(e) { /* tenta próximo */ }
            }
        } catch(e) {
            logArr.push("executeCommand: err: " + e.message);
        } finally {
            if (savedActiveSeq) { try { app.project.activeSequence = savedActiveSeq; } catch(e) {} }
        }
    }

    if (!newSeq) { logArr.push("FALHOU: nenhum método de cópia disponível nesta versão do Premiere"); return null; }

    // ── Renomeia ──────────────────────────────────────────────────────────────
    // ATENÇÃO: NÃO atribuir newSeq.name = copyName pois em ExtendScript isso
    // corrompe o getter nativo, fazendo .name retornar undefined depois.
    // Usamos APENAS o ProjectItem.rename() para renomear.
    var defaultName = newSeq.name; // Nome padrão do Premiere: ex "[TEMPLATE]PRECO Copy"
    logArr.push("Cópia criada: '" + defaultName + "'");

    try {
        var piRename = findProjectItem(defaultName);
        if (piRename) {
            // ProjectItem.rename() não existe no PPRO 2025 — usa atribuição de propriedade
            piRename.name = copyName;
            logArr.push("rename → '" + copyName + "' ok");
        } else {
            logArr.push("rename: item '" + defaultName + "' não encontrado no projeto");
        }
    } catch(eRen) { logArr.push("rename err: " + eRen.message); }

    // ── Move para pasta "Auto Editor - Montagem" ──────────────────────────────
    try {
        var bin = getOrCreateBin("Auto Editor - Montagem");
        var seqItemToMove = findProjectItem(copyName) || findProjectItem(defaultName);
        if (seqItemToMove) {
            seqItemToMove.moveBin(bin);
            logArr.push("moveBin ok");
        } else {
            logArr.push("moveBin: item não encontrado nem por copyName nem por defaultName");
        }
    } catch (eMov) { logArr.push("moveBin err: " + eMov.message); }

    return newSeq;
}

// Insere um template na timeline ativa como cópia independente por produto.
// `extras` (opcional): {
//   textOverrides:  {placeholder: value},  // texto custom (LOWERTHIRD)
//   copyNameSuffix: "lt1",                 // sufixo de naming por instância
//   expand:         true                   // se true, expande conteúdo da seq
//                                          // na main ao invés de aninhar
// }
function insertTemplate(templateName, trackIndex, startSec, product, extras) {
    var updateLog = []; // hoisted: precisamos retornar mesmo em catch
    try {
        extras = extras || {};
        var textOverrides   = extras.textOverrides   || null;
        var copyNameSuffix  = extras.copyNameSuffix  || "";
        var expandMode      = !!extras.expand;
        var anchorMode      = extras.anchor || null; // "cut" pra transições

        // ── Salva a sequência PRINCIPAL antes de qualquer outra operação ──────
        // createProductSequenceCopy muda app.project.activeSequence durante o processo;
        // precisamos desta referência para inserir na sequência correta no final.
        var mainSeq = app.project.activeSequence;
        if (!mainSeq) return JSON.stringify({ error: "Nenhuma sequência ativa." });

        // ═══════════ CAMINHO MASTERCLIP (preferencial quando disponível) ══════
        // Se existe um ProjectItem na bin com nome [TEMPLATE]NAME (drag de clip
        // configurado da timeline pra bin), usa caminho direto: insere o clip e
        // substitui texto. Tudo (cor/posição/escala/efeitos) vem do MasterClip.
        // É o caminho mais simples e robusto — sem clone, sem expand, sem cópia
        // de props. Animações responsivas do MOGRT funcionam nativamente.
        var templateClip = findTemplateProjectItem(templateName);
        if (templateClip) {
            updateLog.push("Template é MasterClip: '" + templateClip.name + "' — inserção direta");

            var mcTrack = ensureVideoTrack(mainSeq, trackIndex);
            var mcTime  = new Time();
            mcTime.ticks = toTicks(startSec);

            try {
                mcTrack.overwriteClip(templateClip, mcTime);
            } catch (eOver) {
                return JSON.stringify({
                    error: "overwriteClip falhou: " + eOver.message, updateLog: updateLog
                });
            }

            // Encontra o clip recém-inserido (start ~= startSec)
            var TPSM = 254016000000;
            var insertedClip = null;
            var startTicks = parseFloat(toTicks(startSec));
            for (var nci = mcTrack.clips.numItems - 1; nci >= 0; nci--) {
                var cand = mcTrack.clips[nci];
                var cs = 0;
                try { cs = parseFloat(cand.start.ticks); } catch(eC) {}
                if (Math.abs(cs - startTicks) < TPSM) { insertedClip = cand; break; }
            }

            if (!insertedClip) {
                updateLog.push("MASTERCLIP: clip inserido mas não localizado pra subst de texto");
                return JSON.stringify({
                    success: true, masterclip: true, updateLog: updateLog
                });
            }

            // Aplica substituições de texto (product + textOverrides) no clip
            // novo. Como MasterClip já tem [[INFO]]/[[SUB-INFO]] como defaults,
            // o processClipTextProps acha os [[ e substitui pelo texto custom.
            var substLog = [];
            var clipName = "?";
            try { clipName = insertedClip.name || "?"; } catch(eN) {}
            var subLabel = "TEXT '" + clipName.substring(0, 25) + "'";

            if (clipName.indexOf("[[") >= 0) {
                tryClipNameSubstitution(insertedClip, clipName, product || {}, substLog, textOverrides);
            }
            try {
                for (var co = 0; co < insertedClip.components.numItems; co++) {
                    var comp = insertedClip.components[co];
                    if (comp.properties && comp.properties.numItems > 0) {
                        processClipTextProps(comp.properties, product || {}, substLog, subLabel, textOverrides);
                    }
                }
            } catch (eWalk) {
                substLog.push(subLabel + " walk err: " + eWalk.message);
            }

            updateLog.push("MASTERCLIP: " + substLog.length + " linha(s) de subst");
            for (var sl = 0; sl < substLog.length; sl++) {
                updateLog.push("  " + substLog[sl]);
            }

            return JSON.stringify({
                success: true, masterclip: true, updateLog: updateLog
            });
        }

        // ═══════════ CAMINHO SEQUENCE (fluxo original) ══════════════════════════
        var templateSeq = findTemplateSequence(templateName);
        if (!templateSeq) {
            // Lista o que existe na bin pra ajudar debug
            var found = [];
            try {
                for (var sq = 0; sq < app.project.sequences.numSequences; sq++) {
                    var snm = app.project.sequences[sq].name || "";
                    if (snm.indexOf("[TEMPLATE]") === 0) found.push("seq: " + snm);
                }
            } catch(eL) {}
            return JSON.stringify({
                error: "Template não encontrado: " + templateName +
                    ". Existentes: " + (found.length ? found.join(", ") : "nenhum") +
                    ". Crie uma Sequence [TEMPLATE]" + templateName +
                    " OU drag um clip configurado pra bin com esse nome.",
                updateLog: updateLog
            });
        }

        // ═══════════ CAMINHO DIRETO PARA MODO EXPAND ═══════════════════════════
        // Pula todo o fluxo de clone+substitui+restaura. Expand insere os clips
        // DIRETO do template original na main timeline; cada novo clip-instance
        // tem seus próprios component values isolados, então aplicamos as
        // substituições per-instance (texto custom de LOWERTHIRD) DEPOIS de
        // inserir, sem afetar outros lower thirds da mesma sequência.
        if (expandMode) {
            updateLog.push("Modo EXPAND: inserindo conteúdo direto na timeline (sem clone)");

            var expandRes = expandSequenceIntoMain(templateSeq, mainSeq, trackIndex, startSec, anchorMode);
            updateLog.push("EXPAND: " + expandRes.inserted + " clip(s) em " +
                expandRes.tracksUsed + " track(s) a partir de V" + (trackIndex + 1));
            for (var el = 0; el < expandRes.log.length; el++) {
                updateLog.push("  EXPAND: " + expandRes.log[el]);
            }

            if (!expandRes.ok) {
                return JSON.stringify({
                    error: "EXPAND falhou: nenhum clip inserido", updateLog: updateLog
                });
            }

            // Aplica substituições nos clips recém-inseridos LENDO o src do template.
            // Crítico: overwriteClip(MasterClip) cria o clip dst com os DEFAULTS
            // do MOGRT (ex: "minimal TYPOGRAPHY"), NÃO com os [[INFO]]/[[SUB-INFO]]
            // que o usuário botou na seq template. Por isso lemos do src (que TEM
            // os placeholders no TextDocument estilizado), substituímos, e escrevemos
            // no dst — assim o dst herda fonte/estilo do template + texto custom.
            var pairs = expandRes.clipPairs || [];
            if (pairs.length > 0) {
                var substLog = [];
                var totalApplied = 0;
                for (var ic = 0; ic < pairs.length; ic++) {
                    var pair = pairs[ic];
                    var clipName = "?";
                    try { clipName = pair.dst.name || "?"; } catch(eN) {}
                    var beforeCount = substLog.length;
                    var applied = copyClipTextWithSubstitutions(
                        pair.src, pair.dst, product || {}, textOverrides, substLog
                    );
                    totalApplied += applied;
                    // Prefixa o label do clip nas linhas adicionadas
                    for (var sli = beforeCount; sli < substLog.length; sli++) {
                        substLog[sli] = "'" + clipName.substring(0, 25) + "' " + substLog[sli];
                    }
                }
                updateLog.push("  TEXT: " + totalApplied + " substituição(ões) aplicada(s)");
                for (var sl = 0; sl < substLog.length; sl++) {
                    updateLog.push("    " + substLog[sl]);
                }
            }

            return JSON.stringify({
                success: true, expanded: true,
                inserted: expandRes.inserted, tracksUsed: expandRes.tracksUsed,
                updateLog: updateLog
            });
        }
        // ═══════════ FIM DO CAMINHO EXPAND ═════════════════════════════════════

        var seqToInsert = templateSeq;

        // Nome da cópia — calculado antes de qualquer operação de cópia
        var copyName   = null;
        var seqItemRef = null; // nome canônico para busca no projeto

        if (product && (product.name || product.brand || product.price || product.price_min)) {
            var label = (product.brand || "") + "_" + (product.name || "");
            label = label.replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_").substring(0, 30);
            var baseName = templateSeq.name.replace("[TEMPLATE] ", "").replace("[TEMPLATE]", "").replace(/^\s+|\s+$/g, "");
            copyName = "[" + baseName + "] " + label + (copyNameSuffix ? "_" + copyNameSuffix : "");

            // ── Via rápida: sequência já importada via patch de prproj ──────────
            // mountWithPrprojPatch cria um prproj temporário com o texto substituído
            // e o importa ANTES de chamar mountFromJSON. Se a sequência já existe
            // com o nome correto, usamos ela diretamente — sem tocar no template.
            var preparedSeq = null;
            for (var ec = 0; ec < app.project.sequences.numSequences; ec++) {
                if (app.project.sequences[ec].name === copyName) {
                    preparedSeq = app.project.sequences[ec];
                    break;
                }
            }

            if (preparedSeq) {
                updateLog.push("Usando sequência pré-preparada (prproj patch): " + copyName);
                updateLog.unshift("Sequência criada: " + copyName);
                seqToInsert = preparedSeq;
                seqItemRef  = copyName;
                // O texto já foi substituído no binário <PremiereFilterPrivateData>
                // pelo patch do prproj (patchEGBlobsInXML). Não chamamos setValue
                // para não sobrescrever o TextDocument estilizado com uma string plana.

            } else {
                // ── Estratégia fallback: modifica original → clona → restaura ─────
                // Usado quando o prproj patch não estava disponível.
                // O Source Text em clones retorna len=1 (clone() não copia dados EG).
                // Modificamos o TEMPLATE ORIGINAL (que tem os dados acessíveis) ANTES
                // de clonar; o clone herda o texto substituído; depois restauramos o
                // placeholder no template.

                // 1. Ativa o template para que getValue() retorne o binário real
                try { app.project.activeSequence = templateSeq; } catch(eActT) {}

                // 2. Salva binários originais de Source Text (para restaurar depois)
                var savedTextVals = saveSourceTextValues(templateSeq);
                for (var sv = 0; sv < savedTextVals.length; sv++) {
                    var svLen = savedTextVals[sv].val ? String(savedTextVals[sv].val).length : 0;
                    updateLog.push("  ORIG '" + savedTextVals[sv].clipName + "': len=" + svLen);
                }

                // 3. Aplica substituições de TEXTO no template (skipImage: true)
                //    NÃO toca no clip [[PRODUCT_IMAGE]] — caso contrário o placeholder
                //    seria removido permanentemente do template e produtos 2+ não
                //    achariam mais o clip pra trocar pelo PNG correto.
                //    `extras` aqui passa textOverrides (LOWERTHIRD: INFO/SUB-INFO).
                try {
                    var preModLog = updateTemplatePlaceholders(templateSeq, product, {
                        skipImage: true,
                        extraPlaceholders: textOverrides
                    });
                    for (var pml = 0; pml < preModLog.length; pml++) updateLog.push(preModLog[pml]);
                } catch(ePreMod) { updateLog.push("pre-mod err: " + ePreMod.message); }

                // 4. Clona o template MODIFICADO — o clone herda o texto substituído
                //    E ainda tem o placeholder [[PRODUCT_IMAGE]] intacto pra trocar depois.
                var copyLog = [];
                var copiedSeq = createProductSequenceCopy(templateSeq, copyName, copyLog);
                for (var cl = 0; cl < copyLog.length; cl++) updateLog.push("  COPY: " + copyLog[cl]);

                // 5. Restaura o placeholder de TEXTO original no template
                restoreSourceTextValues(savedTextVals);

                // 6. Troca o PNG do produto NA CÓPIA (skipText: true) usando o
                //    image_transparent específico deste produto. O template fica
                //    intacto com o [[PRODUCT_IMAGE]] pra próximos produtos.
                if (copiedSeq) {
                    try {
                        try { app.project.activeSequence = copiedSeq; } catch(eAC) {}
                        var imgLog = updateTemplatePlaceholders(copiedSeq, product, { skipText: true });
                        for (var il = 0; il < imgLog.length; il++) updateLog.push("  IMG: " + imgLog[il]);
                    } catch(eImg) { updateLog.push("img-replace err: " + eImg.message); }
                }

                // 7. Restaura a sequência principal
                try { app.project.activeSequence = mainSeq; } catch(eRestore) {}

                if (copiedSeq) {
                    updateLog.unshift("Sequência criada: " + copyName);
                    seqToInsert = copiedSeq;

                    // Usa sequenceID para encontrar o nome REAL do item no projeto
                    try {
                        var targetID = copiedSeq.sequenceID;
                        for (var si2 = 0; si2 < app.project.sequences.numSequences; si2++) {
                            var sMatch = app.project.sequences[si2];
                            if (sMatch.sequenceID === targetID) {
                                seqItemRef = sMatch.name;
                                updateLog.push("item real no projeto: '" + seqItemRef + "'");
                                break;
                            }
                        }
                    } catch(eSI) { updateLog.push("sequenceID lookup err: " + eSI.message); }

                    if (!seqItemRef) seqItemRef = copyName; // fallback
                } else {
                    // Cópia falhou — template já foi restaurado
                    updateLog.unshift("AVISO: cópia falhou, usando template original");
                    seqItemRef = templateSeq.name;
                }
            }
        } else {
            seqItemRef = templateSeq.name;
        }

        // ── MODO ANINHADO (padrão): insere a sequência cópia como um clip ─────
        // (modo EXPAND já tratado mais acima e retornou — não chega aqui)
        var seqItem = findProjectItem(seqItemRef);
        if (!seqItem) return JSON.stringify({ error: "Item da sequência não encontrado: " + seqItemRef, updateLog: updateLog });

        var track     = ensureVideoTrack(mainSeq, trackIndex);
        var startTime = new Time();
        startTime.ticks = toTicks(startSec);

        track.overwriteClip(seqItem, startTime);

        return JSON.stringify({ success: true, updateLog: updateLog });
    } catch (e) {
        return JSON.stringify({ error: e.message, updateLog: updateLog });
    }
}

// ─── UTILITÁRIO: duração de um template pelo nome parcial ────────────────────
// Equivale a getTemplateDurations mas pra um único nome, sem overhead de JSON.
function measureTemplateDuration(name) {
    try {
        for (var si = 0; si < app.project.sequences.numSequences; si++) {
            var s = app.project.sequences[si];
            if (s.name !== name &&
                s.name !== "[TEMPLATE] " + name &&
                s.name !== "[TEMPLATE]"  + name) continue;

            // Método 0 (PRIORITÁRIO): range In/Out do item = duração realmente inserida.
            try {
                var srcDur = templateSourceDuration(s.name);
                if (srcDur > 0) return srcDur;
            } catch(e0) {}

            // Método 1: s.end.ticks
            try {
                var t1 = parseFloat(s.end.ticks);
                if (t1 > 0) return t1 / TICKS_PER_SECOND;
            } catch(e1) {}
            // Método 2: s.end.seconds
            try {
                var t2 = parseFloat(s.end.seconds);
                if (t2 > 0) return t2;
            } catch(e2) {}
            // Método 3: maior endTime entre clips (mais confiável)
            try {
                var maxEnd = 0;
                for (var t = 0; t < s.videoTracks.numTracks; t++) {
                    var tr = s.videoTracks[t];
                    for (var c = 0; c < tr.clips.numItems; c++) {
                        var et = parseFloat(tr.clips[c].end.ticks);
                        if (et > maxEnd) maxEnd = et;
                    }
                }
                for (var ta = 0; ta < s.audioTracks.numTracks; ta++) {
                    var tra = s.audioTracks[ta];
                    for (var ca = 0; ca < tra.clips.numItems; ca++) {
                        var eta = parseFloat(tra.clips[ca].end.ticks);
                        if (eta > maxEnd) maxEnd = eta;
                    }
                }
                if (maxEnd > 0) return maxEnd / TICKS_PER_SECOND;
            } catch(e3) {}
            // Não encontrou duração válida
            return 0;
        }
    } catch(e) {}
    return 0;
}

// ─── CAPÍTULOS (YouTube) ────────────────────────────────────────────────────
// Monta a lista de capítulos a partir dos produtos já com time_seconds resolvido.
//   - Introdução sempre em 0s
//   - Cada produto no CORTE de entrada (time do card PRODUTO = onde a transição cai)
//   - Exceção CTA: produto com cta_before=true começa no FIM do preço do produto
//     anterior (= início do CTA), pra quem pular não perder o CTA de inscrição
//   - Conclusão: no FIM do preço do último produto (título configurável)
function buildChaptersList(products, precoDur, conclusionTitle) {
    if (!precoDur || precoDur <= 0) precoDur = 5;
    var chaps = [{ time: 0, title: "Introdução" }];

    function itemTime(it) {
        if (it.time_seconds == null) return null;
        return it.time_seconds + (it.offset_seconds ? it.offset_seconds : 0);
    }
    // Início do produto = time do card PRODUTO (o corte de entrada). Fallback: menor time.
    function productStart(prod) {
        var items = prod.timeline || [], produtoT = null, minT = null;
        for (var i = 0; i < items.length; i++) {
            var t = itemTime(items[i]); if (t == null) continue;
            if (minT === null || t < minT) minT = t;
            if ((items[i].template || "").toUpperCase() === "PRODUTO" && produtoT === null) produtoT = t;
        }
        return (produtoT !== null) ? produtoT : minT;
    }
    // Fim do preço = time do último PRECO + duração do card de preço.
    function productPrecoEnd(prod) {
        var items = prod.timeline || [], precoT = null;
        for (var i = 0; i < items.length; i++) {
            if ((items[i].template || "").toUpperCase() === "PRECO") {
                var t = itemTime(items[i]); if (t != null) precoT = t;
            }
        }
        return (precoT !== null) ? (precoT + precoDur) : null;
    }

    for (var p = 0; p < products.length; p++) {
        var prod = products[p];
        var title = prod.chapter_title;
        if (!title) {
            title = ((prod.brand ? prod.brand + " " : "") + (prod.name || ("Produto " + (p + 1))));
            title = title.replace(/^\s+|\s+$/g, "");
        }
        var time;
        if (prod.cta_before && p > 0) {
            var prevEnd = productPrecoEnd(products[p - 1]);
            time = (prevEnd !== null) ? prevEnd : productStart(prod);
        } else {
            time = productStart(prod);
        }
        if (time !== null && time !== undefined) chaps.push({ time: time, title: title });
    }

    // Conclusão: fim do preço do último produto que tenha PRECO resolvido.
    if (conclusionTitle !== false) {
        var lastEnd = null;
        for (var q = products.length - 1; q >= 0 && lastEnd === null; q--) {
            lastEnd = productPrecoEnd(products[q]);
        }
        if (lastEnd !== null) {
            chaps.push({ time: lastEnd, title: conclusionTitle || "Conclusão" });
        }
    }

    // Ordena por tempo e remove duplicatas de tempo (mantém o primeiro título).
    chaps.sort(function (a, b) { return a.time - b.time; });
    var out = [], lastT = -1;
    for (var k = 0; k < chaps.length; k++) {
        var ti = Math.floor(chaps[k].time);
        if (ti === lastT) continue;
        out.push({ time: chaps[k].time, title: chaps[k].title });
        lastT = ti;
    }
    return out;
}

// Remove todos os marcadores de SEQUÊNCIA da timeline (os capítulos são
// regerados a cada montagem). Retorna quantos removeu.
function clearSequenceMarkers(seq) {
    var removed = 0;
    try {
        var m = seq.markers.getFirstMarker();
        while (m) {
            var next = null;
            try { next = seq.markers.getNextMarker(m); } catch (eN) {}
            try { seq.markers.removeMarker(m); removed++; } catch (eR) {}
            m = next;
        }
    } catch (e) {}
    return removed;
}

// Lê os marcadores de SEQUÊNCIA da timeline ativa e devolve {time, title}
// ordenado por tempo. Usado pelo botão "Atualizar Capítulos" pra refletir
// marcadores que o usuário moveu de lugar depois da montagem.
function getChaptersFromMarkers() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return JSON.stringify({ error: "Nenhuma sequência ativa." });
        var chaps = [];
        var m = seq.markers.getFirstMarker();
        while (m) {
            var t = 0;
            try { t = parseFloat(m.start.ticks) / TICKS_PER_SECOND; } catch (eT) {}
            var title = "";
            try { title = m.name || ""; } catch (eN) {}
            if (!title) { try { title = m.comments || ""; } catch (eC) {} }
            chaps.push({ time: t, title: title });
            var next = null;
            try { next = seq.markers.getNextMarker(m); } catch (eNx) {}
            m = next;
        }
        chaps.sort(function (a, b) { return a.time - b.time; });
        return JSON.stringify({ ok: true, chapters: chaps });
    } catch (e) { return JSON.stringify({ error: e.message }); }
}

// Duração do CONTEÚDO interno do template (maxClipEnd) — usado como limite máximo
// de esticamento do PRECO (a "reserva" que o usuário criou estendendo a sequência).
// Diferente de templateSourceDuration (que mede o range In/Out = o que é inserido).
function templateContentDuration(name) {
    try {
        for (var si = 0; si < app.project.sequences.numSequences; si++) {
            var s = app.project.sequences[si];
            if (s.name !== name && s.name !== "[TEMPLATE] " + name && s.name !== "[TEMPLATE]" + name) continue;
            var maxEnd = 0;
            for (var t = 0; t < s.videoTracks.numTracks; t++) {
                var tr = s.videoTracks[t];
                for (var c = 0; c < tr.clips.numItems; c++) {
                    try { var et = parseFloat(tr.clips[c].end.ticks); if (et > maxEnd) maxEnd = et; } catch (e1) {}
                }
            }
            for (var ta = 0; ta < s.audioTracks.numTracks; ta++) {
                var tra = s.audioTracks[ta];
                for (var ca = 0; ca < tra.clips.numItems; ca++) {
                    try { var eta = parseFloat(tra.clips[ca].end.ticks); if (eta > maxEnd) maxEnd = eta; } catch (e2) {}
                }
            }
            if (maxEnd > 0) return maxEnd / TICKS_PER_SECOND;
        }
    } catch (e) {}
    return 0;
}

// Duração (segundos) de um projectItem de footage (vídeo na bin). Tenta out-in,
// depois QE. Retorna 0 se não conseguir medir.
function projectItemMediaDuration(pi) {
    if (!pi) return 0;
    // Método 1: getOutPoint - getInPoint
    try {
        if (typeof pi.getOutPoint === "function") {
            var outP = timeObjToSeconds(pi.getOutPoint());
            var inP = 0;
            try { inP = timeObjToSeconds(pi.getInPoint()); } catch (eIn) {}
            if (isNaN(inP)) inP = 0;
            if (!isNaN(outP) && outP > inP) return outP - inP;
        }
    } catch (e1) {}
    // Método 2: campos diretos (algumas versões)
    try { if (pi.duration) { var d = timeObjToSeconds(pi.duration); if (d > 0) return d; } } catch (e2) {}
    return 0;
}

// Acha os vídeos PROD_<folder>, PROD_<folder>_2, _3... na bin (em sequência) e
// mede a duração de cada. foldersJSON = ["1","2",...]. Retorna
// { "1": { videos:[{name,dur}], total }, ... }.
// Acha um item da bin pelo nome IGNORANDO a extensão (ex: base "PROD_1" casa com
// "PROD_1", "PROD_1.webm", "PROD_1.mp4"...). Retorna o projectItem ou null.
function findVideoBinItem(base) {
    var target = String(base).toUpperCase();
    function strip(n) { var i = n.lastIndexOf("."); return (i > 0 ? n.substring(0, i) : n).toUpperCase(); }
    var found = null;
    function search(parent) {
        for (var i = 0; i < parent.children.numItems && !found; i++) {
            var c = parent.children[i];
            var nm = "";
            try { nm = c.name || ""; } catch (e) {}
            if (nm) {
                var up = nm.toUpperCase();
                if (up === target || strip(nm) === target) { found = c; return; }
            }
            if (c.children && c.children.numItems > 0) search(c);
        }
    }
    try { search(app.project.rootItem); } catch (e) {}
    return found;
}

function getProductVideoInfo(foldersJSON) {
    var out = {};
    try {
        var folders = JSON.parse(foldersJSON);
        for (var f = 0; f < folders.length; f++) {
            var folder = String(folders[f]);
            var base = "PROD_" + folder;
            var vids = [];
            var total = 0;
            // PROD_<folder> (sem sufixo), depois _2, _3, ... (ignora extensão no match)
            var first = findVideoBinItem(base);
            if (first) {
                var d0 = projectItemMediaDuration(first);
                vids.push({ name: first.name, dur: d0 }); total += d0;
                for (var n = 2; n < 50; n++) {
                    var pit = findVideoBinItem(base + "_" + n);
                    if (!pit) break;
                    var dn = projectItemMediaDuration(pit);
                    vids.push({ name: pit.name, dur: dn }); total += dn;
                }
            }
            if (vids.length) out[folder] = { videos: vids, total: total };
        }
    } catch (e) {}
    return JSON.stringify(out);
}

// Desabilita (muta) clips de áudio recém-inseridos perto de startSec com nome
// igual ao vídeo. Usado pra inserir o vídeo SEM áudio (só vídeo). Não toca na
// narração (que fica em A1; o áudio do vídeo cai numa track de áudio paralela).
function muteInsertedAudio(seq, name, startSec) {
    try {
        var target = String(name || "").toUpperCase();
        var startTicks = startSec * TICKS_PER_SECOND;
        for (var t = 0; t < seq.audioTracks.numTracks; t++) {
            var tr = seq.audioTracks[t];
            for (var c = 0; c < tr.clips.numItems; c++) {
                var clp = tr.clips[c];
                var nm = ""; try { nm = (clp.name || "").toUpperCase(); } catch (eN) { continue; }
                var cs = 0; try { cs = parseFloat(clp.start.ticks); } catch (eS) { continue; }
                if (Math.abs(cs - startTicks) < 0.6 * TICKS_PER_SECOND &&
                    (nm === target || (target && nm.indexOf(target) >= 0))) {
                    try { clp.disabled = true; } catch (eD) {}   // muta
                    try { clp.remove(false, false); } catch (eR) {} // tenta remover de fato
                }
            }
        }
    } catch (e) {}
}

// Insere um item da BIN (por nome) num tempo/track. Pra vídeo: corta se passar da
// janela e remove o áudio. Pra imagem (forceExact=true): seta a duração exata (stills
// podem ter qualquer duração). Aplica Scale to Frame Size.
// Aplica o efeito "fundo borrado" pra vídeos verticais/quadrados:
// 1. Mantém o clip original (que JÁ tem scale FILL) e adiciona Gaussian Blur ~50.
// 2. Duplica o vídeo na track ACIMA com scale FIT (cabe inteiro, sem cortar topo/baixo)
//    e sem blur — esse é o foreground.
// O resultado é o vídeo cheio visível em cima de uma versão borrada cobrindo o frame todo.
// Só aplica em vídeo (forceExact=false). Se W/H >= 1.2 considera landscape e pula.
function applyBlurredBackgroundEffect(seq, trackIndex, item, startSec, durationSec, sfRes) {
    var info = { applied: false, log: [] };
    try {
        if (!sfRes || !sfRes.srcW || !sfRes.srcH || !sfRes.seqW || !sfRes.seqH) {
            info.log.push("sem dims — skipped"); return info;
        }
        var srcW = sfRes.srcW, srcH = sfRes.srcH;
        var seqW = sfRes.seqW, seqH = sfRes.seqH;
        if (srcW >= srcH * 1.2) { info.log.push("landscape (" + srcW + "x" + srcH + ") — skipped"); return info; }

        info.log.push("vertical/quadrado " + srcW + "x" + srcH);

        // ── 1. Acha o clip original (com FILL scale já aplicado).
        var origTrack = seq.videoTracks[trackIndex];
        var startT = new Time(); startT.ticks = toTicks(startSec);
        var targetTicks = parseFloat(startT.ticks);
        var origClip = null, bestDD = Infinity;
        for (var c = 0; c < origTrack.clips.numItems; c++) {
            var cc = origTrack.clips[c];
            if (!cc || !cc.start) continue;
            var dd = Math.abs(parseFloat(cc.start.ticks) - targetTicks);
            if (dd < bestDD) { bestDD = dd; origClip = cc; }
        }
        if (!origClip) { info.log.push("clip orig não achado"); return info; }

        // ── 2. Adiciona Gaussian Blur ao clip original via QE.
        var blurEffectName = null;
        try {
            app.enableQE();
            var qeSeq = qe.project.getActiveSequence();
            var qeTr = qeSeq.getVideoTrackAt(trackIndex);
            var qeClip = null;
            for (var qi = 0; qi < qeTr.numItems; qi++) {
                var qit = qeTr.getItemAt(qi);
                if (!qit || !qit.start) continue;
                try {
                    if (Math.abs(parseFloat(qit.start.ticks) - targetTicks) < 4e9) { qeClip = qit; break; }
                } catch (eQS) {}
            }
            if (qeClip) {
                var effectCandidates = ["Gaussian Blur", "Desfoque Gaussiano", "Desfoque gaussiano"];
                for (var en = 0; en < effectCandidates.length; en++) {
                    try {
                        var fx = qe.project.getVideoEffectByName(effectCandidates[en]);
                        if (fx) {
                            qeClip.addVideoEffect(fx);
                            blurEffectName = effectCandidates[en];
                            info.log.push("blur fx adicionado: " + blurEffectName);
                            break;
                        }
                    } catch (eFn) {}
                }
                if (!blurEffectName) info.log.push("blur fx: não encontrado por nome em " + effectCandidates.join("/"));
            } else {
                info.log.push("qeClip não achado");
            }
        } catch (eAdd) { info.log.push("addEffect err: " + eAdd.message); }

        // ── 3. Set Blurriness = 50 no clip original.
        if (blurEffectName) {
            try {
                for (var ci = 0; ci < origClip.components.numItems; ci++) {
                    var comp = origClip.components[ci];
                    var cdn = comp.displayName || "";
                    if (cdn === blurEffectName) {
                        for (var pi = 0; pi < comp.properties.numItems; pi++) {
                            var prop = comp.properties[pi];
                            var pdn = prop.displayName || "";
                            // "Blurriness" (EN), "Borrão" (PT). Fallback: a 1ª prop numérica.
                            if (pdn === "Blurriness" || pdn === "Borrão" || pdn.toLowerCase().indexOf("blur") >= 0) {
                                prop.setValue(50, true);
                                info.log.push("blurriness=50 (" + pdn + ")");
                                break;
                            }
                        }
                        break;
                    }
                }
            } catch (eBlur) { info.log.push("setBlur err: " + eBlur.message); }
        }

        // ── 4. Duplica clip na track ACIMA (track+1).
        var topTrackIdx = trackIndex + 1;
        var topTrack = ensureVideoTrack(seq, topTrackIdx);
        topTrack.overwriteClip(item, startT);

        var topClip = null, bestDD2 = Infinity;
        for (var tc = 0; tc < topTrack.clips.numItems; tc++) {
            var tcc = topTrack.clips[tc];
            if (!tcc || !tcc.start) continue;
            var dd2 = Math.abs(parseFloat(tcc.start.ticks) - targetTicks);
            if (dd2 < bestDD2) { bestDD2 = dd2; topClip = tcc; }
        }

        // Trim mesmo end (espelha duração do original).
        if (topClip && durationSec > 0) {
            try {
                var natEnd2 = parseFloat(topClip.end.ticks) / TICKS_PER_SECOND;
                var wantEnd2 = startSec + durationSec;
                if (natEnd2 > wantEnd2 + 0.04) {
                    var et2 = new Time(); et2.ticks = toTicks(wantEnd2);
                    topClip.end = et2;
                }
            } catch (eTrim2) {}
        }

        // Muta o áudio do duplicado (igual ao original).
        try { muteInsertedAudio(seq, item.name, startSec); } catch (eMute) {}

        // ── 5. Aplica FIT scale ao top clip (cabe inteiro, sem cortar).
        if (topClip) {
            var fitRatio = Math.min(seqW / srcW, seqH / srcH); // FIT
            var fitScale = fitRatio * 100;
            try {
                var motion = null;
                var motionNames = ["Motion", "Movimento"];
                for (var ci2 = 0; ci2 < topClip.components.numItems; ci2++) {
                    var compDN2 = topClip.components[ci2].displayName || "";
                    for (var mn = 0; mn < motionNames.length; mn++) {
                        if (compDN2 === motionNames[mn]) { motion = topClip.components[ci2]; break; }
                    }
                    if (motion) break;
                }
                if (motion) {
                    var scaleProp = null;
                    var scaleNames = ["Scale", "Escala"];
                    for (var pj2 = 0; pj2 < motion.properties.numItems; pj2++) {
                        var propDN2 = motion.properties[pj2].displayName || "";
                        for (var sn = 0; sn < scaleNames.length; sn++) {
                            if (propDN2 === scaleNames[sn]) { scaleProp = motion.properties[pj2]; break; }
                        }
                        if (scaleProp) break;
                    }
                    if (scaleProp) {
                        scaleProp.setValue(fitScale, true);
                        info.log.push("top FIT scale=" + fitScale.toFixed(1) + "% (track " + topTrackIdx + ")");
                    }
                }
            } catch (eFitScale) { info.log.push("fitScale err: " + eFitScale.message); }
        }

        info.applied = !!blurEffectName;
        return info;
    } catch (e) {
        info.log.push("exception: " + e.message);
        return info;
    }
}

function insertBinClipAtTime(name, trackIndex, startSec, durationSec, srcW, srcH, forceExact) {
    try {
        var seq = app.project.activeSequence;
        var item = findProjectItem(name) || findVideoBinItem(name);
        if (!item) return JSON.stringify({ error: "Bin clip não encontrado: " + name });
        var track = ensureVideoTrack(seq, trackIndex);
        var startTime = new Time(); startTime.ticks = toTicks(startSec);
        track.overwriteClip(item, startTime);
        // acha o clip recém-inserido (mais próximo do start)
        var bestClip = null, bestDD = Infinity, targetT = parseFloat(startTime.ticks);
        for (var c = 0; c < track.clips.numItems; c++) {
            var cc = track.clips[c];
            if (!cc || !cc.start) continue;
            var dd = Math.abs(parseFloat(cc.start.ticks) - targetT);
            if (dd < bestDD) { bestDD = dd; bestClip = cc; }
        }
        if (bestClip && durationSec > 0) {
            try {
                var natEnd = parseFloat(bestClip.end.ticks) / TICKS_PER_SECOND;
                var wantEnd = startSec + durationSec;
                // forceExact (imagem): seta sempre. Vídeo: só corta se passar da janela.
                if (forceExact || natEnd > wantEnd + 0.04) {
                    var et = new Time(); et.ticks = toTicks(wantEnd);
                    bestClip.end = et;
                }
            } catch (eTrim) {}
        }
        // Remove o áudio (só relevante pra vídeo; imagem não tem).
        muteInsertedAudio(seq, item.name, startSec);

        var sfRes = null;
        try { sfRes = applyScaleToFrameSize(seq, track, startTime.ticks, srcW, srcH); } catch (eSF) {}

        // Efeito de fundo borrado pra vídeos verticais/quadrados (não pra imagens).
        var blurBg = null;
        if (!forceExact) {
            try { blurBg = applyBlurredBackgroundEffect(seq, trackIndex, item, startSec, durationSec, sfRes); }
            catch (eBg) { blurBg = { applied: false, log: ["exception: " + eBg.message] }; }
        }

        return JSON.stringify({ success: true, scaleToFrame: sfRes, blurBg: blurBg });
    } catch (e) {
        return JSON.stringify({ error: e.message });
    }
}

// ── MODELO POR BIN: tudo vem do bin PROD_N do projeto ────────────────────────
// Classifica os filhos do bin em vídeos/imagens (pela extensão da mídia), separa a
// imagem de referência ("png"). Retorna { "1": {ref, videos:[{name,dur}], images:[{name}], videoTotal}, ... }
function getProductBinMedia(foldersJSON) {
    var out = {};
    var VEXT = { mp4:1, mov:1, webm:1, avi:1, mkv:1, m4v:1, wmv:1, mpg:1, mpeg:1 };
    var IEXT = { png:1, jpg:1, jpeg:1, webp:1, bmp:1, tif:1, tiff:1, gif:1 };
    function extOf(p) { if (!p) return ""; var i = p.lastIndexOf("."); return (i >= 0 ? p.substring(i + 1) : "").toLowerCase(); }
    function stripExt(n) { var i = n.lastIndexOf("."); return (i > 0 ? n.substring(0, i) : n); }
    try {
        var folders = JSON.parse(foldersJSON);
        var root = app.project.rootItem;
        for (var f = 0; f < folders.length; f++) {
            var folder = String(folders[f]);
            var binName = "PROD_" + folder;
            var bin = null;
            for (var i = 0; i < root.children.numItems; i++) {
                if (root.children[i].name === binName) { bin = root.children[i]; break; }
            }
            if (!bin || !bin.children || bin.children.numItems === 0) continue;
            var ref = null, videos = [], images = [], vtotal = 0;
            for (var c = 0; c < bin.children.numItems; c++) {
                var it = bin.children[c];
                var mp = ""; try { mp = it.getMediaPath() || ""; } catch (eMP) {}
                var nm = ""; try { nm = it.name || ""; } catch (eNm) {}
                var e = extOf(mp || nm);
                var isRef = (stripExt(nm).toLowerCase() === "png");
                if (IEXT[e]) {
                    if (isRef && ref === null) ref = mp;     // referência (não vira b-roll)
                    else images.push({ name: nm });
                } else if (VEXT[e]) {
                    var d = projectItemMediaDuration(it);
                    videos.push({ name: nm, dur: d }); vtotal += d;
                }
                // outros (sequências, áudio, sub-bins) são ignorados
            }
            out[folder] = { ref: ref, videos: videos, images: images, videoTotal: vtotal };
        }
    } catch (e) {}
    return JSON.stringify(out);
}

// Garante o bin PROD_<folder> (cria se não existir) e retorna-o.
function ensureProductBin(folder) {
    return getOrCreateBin("PROD_" + String(folder));
}

// Importa um arquivo (imagem gerada) pro bin PROD_<folder> (cria o bin se preciso).
function importImageToBin(folder, filePath) {
    try {
        var bin = ensureProductBin(folder);
        app.project.importFiles([filePath], true, bin, false);
        return JSON.stringify({ success: true });
    } catch (e) { return JSON.stringify({ error: e.message }); }
}

// Diretório onde o .prproj está salvo (pra criar a pasta AutoEditor_IA ao lado).
function getProjectDir() {
    try {
        var p = app.project.path || "";
        var i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
        return JSON.stringify({ dir: (i >= 0 ? p.substring(0, i) : "") });
    } catch (e) { return JSON.stringify({ dir: "" }); }
}

// ─── ABA RECURSOS (setup: bins de produto + sequências de template) ──────────

// Próximo número de produto disponível: varre os bins PROD_<n> no root e
// retorna o maior + 1 (1 se nenhum existir).
function getNextProductNumber() {
    try {
        var root = app.project.rootItem;
        var max = 0;
        for (var i = 0; i < root.children.numItems; i++) {
            var nm = String(root.children[i].name || "");
            var m = nm.match(/^PROD_(\d+)$/i);
            if (m) { var v = parseInt(m[1], 10); if (v > max) max = v; }
        }
        return JSON.stringify({ next: max + 1 });
    } catch (e) { return JSON.stringify({ next: 1, error: e.message }); }
}

// Diálogo nativo de seleção de arquivos (vídeos + imagens), multi-seleção.
function selectMediaFiles() {
    try {
        var filter;
        if ($.os.indexOf("Windows") >= 0) {
            filter = "Vídeos e imagens:*.mp4;*.mov;*.webm;*.mkv;*.avi;*.m4v;*.mpg;*.mpeg;*.png;*.jpg;*.jpeg;*.gif;*.bmp;*.tif;*.tiff;*.webp,Todos os arquivos:*.*";
        } else {
            filter = function (f) { return true; };
        }
        var sel = File.openDialog("Selecione vídeos e imagens do produto", filter, true);
        if (!sel) return JSON.stringify({ cancelled: true });
        var arr = (sel instanceof Array) ? sel : [sel];
        var paths = [];
        for (var i = 0; i < arr.length; i++) {
            try { paths.push(arr[i].fsName); } catch (e2) {}
        }
        return JSON.stringify({ paths: paths });
    } catch (e) { return JSON.stringify({ error: e.message }); }
}

// Procura, dentro de um bin, o filho cujo getMediaPath() bate com targetPath.
function _findBinChildByMediaPath(bin, targetPath) {
    var target = String(targetPath || "").replace(/\\/g, "/").toLowerCase();
    if (!target) return null;
    for (var i = 0; i < bin.children.numItems; i++) {
        var c = bin.children[i];
        try {
            if (typeof c.getMediaPath === "function") {
                var mp = String(c.getMediaPath() || "").replace(/\\/g, "/").toLowerCase();
                if (mp === target) return c;
            }
        } catch (e) {}
    }
    return null;
}

// Cria/garante o bin PROD_<folder>, importa todos os arquivos e renomeia o
// item de referência (a imagem escolhida) para "png" (o que o resto do plugin
// espera como foto do produto). Retorna resumo.
function addProductMedia(folder, filePathsJSON, refPath) {
    try {
        var paths = JSON.parse(filePathsJSON);
        var bin = ensureProductBin(folder);
        var imported = 0, failed = [];
        for (var i = 0; i < paths.length; i++) {
            var p = paths[i];
            try {
                var f = new File(p);
                if (!f.exists) { failed.push(p); continue; }
                app.project.importFiles([p], true, bin, false);
                imported++;
            } catch (eImp) { failed.push(p); }
        }
        var refResult = "nenhuma";
        if (refPath) {
            var item = _findBinChildByMediaPath(bin, refPath);
            if (item) {
                try { item.name = "png"; refResult = "ok (png)"; }
                catch (eR) { refResult = "rename falhou: " + eR.message; }
            } else {
                refResult = "ref não encontrada no bin";
            }
        }
        try { app.project.save(); } catch (eS) {}
        return JSON.stringify({ ok: true, bin: "PROD_" + String(folder), imported: imported, failed: failed, ref: refResult });
    } catch (e) { return JSON.stringify({ error: e.message }); }
}

function _seqExists(name) {
    try {
        for (var i = 0; i < app.project.sequences.numSequences; i++) {
            if (app.project.sequences[i].name === name) return true;
        }
    } catch (e) {}
    return false;
}

// Cria UMA sequência vazia com o nome dado. Tenta métodos em cascata
// (versões diferentes do Premiere expõem APIs diferentes).
function _createEmptySequence(name) {
    var attempts = [];
    var placeholder = "AEID_" + String(name).replace(/[^A-Za-z0-9]/g, "_");
    // Método 1: createNewSequence(name, placeholderID) → usa preset/settings default
    try {
        app.project.createNewSequence(name, placeholder);
        if (_seqExists(name)) return { ok: true, via: "default" };
        attempts.push("createNewSequence: sem sequência nova");
    } catch (e) { attempts.push("createNewSequence: " + e.message); }
    // Método 2: QE DOM newSequence
    try {
        app.enableQE();
        if (typeof qe !== "undefined" && qe.project && typeof qe.project.newSequence === "function") {
            qe.project.newSequence(name, "");
            if (_seqExists(name)) return { ok: true, via: "qe" };
            attempts.push("qe.newSequence: sem sequência nova");
        } else {
            attempts.push("qe.newSequence: indisponível");
        }
    } catch (e2) { attempts.push("qe.newSequence: " + e2.message); }
    return { ok: false, attempts: attempts };
}

// Cria as sequências de template VAZIAS nomeadas (pula as que já existem).
function createTemplateSequences(namesJSON) {
    try {
        var names = JSON.parse(namesJSON);
        var created = [], skipped = [], failed = [];
        var savedActive = null;
        try { savedActive = app.project.activeSequence; } catch (eA) {}
        for (var i = 0; i < names.length; i++) {
            var nm = names[i];
            if (_seqExists(nm)) { skipped.push(nm); continue; }
            var res = _createEmptySequence(nm);
            if (res.ok) created.push(nm);
            else failed.push({ name: nm, attempts: res.attempts });
        }
        // Restaura a sequência ativa original (criar sequência muda o foco)
        if (savedActive) { try { app.project.activeSequence = savedActive; } catch (eR) {} }
        try { app.project.save(); } catch (eS) {}
        return JSON.stringify({ ok: true, created: created, skipped: skipped, failed: failed });
    } catch (e) { return JSON.stringify({ error: e.message }); }
}

// Recebe uma lista de nomes de template (ex: ["[TEMPLATE]PRODUTO", ...]) e
// devolve quais já existem como Sequence no projeto e quais faltam. Usado pra
// mostrar/esconder o botão "Criar Sequências de Template" na aba Recursos.
function checkTemplateSequences(namesJSON) {
    try {
        var names = JSON.parse(namesJSON);
        var existing = [], missing = [];
        for (var i = 0; i < names.length; i++) {
            if (_seqExists(names[i])) existing.push(names[i]);
            else missing.push(names[i]);
        }
        return JSON.stringify({ existing: existing, missing: missing });
    } catch (e) { return JSON.stringify({ existing: [], missing: [], error: e.message }); }
}

// Lista os bins PROD_<n> existentes no root do projeto (ordenado) + o próximo
// número livre. Usado pelo dropdown "Baixar do YouTube".
function listProductBins() {
    try {
        var root = app.project.rootItem;
        var arr = [];
        for (var i = 0; i < root.children.numItems; i++) {
            var nm = String(root.children[i].name || "");
            var m = nm.match(/^PROD_(\d+)$/i);
            if (m) arr.push(parseInt(m[1], 10));
        }
        arr.sort(function (a, b) { return a - b; });
        var next = arr.length ? arr[arr.length - 1] + 1 : 1;
        return JSON.stringify({ existing: arr, next: next });
    } catch (e) { return JSON.stringify({ existing: [], next: 1, error: e.message }); }
}

// Diretório raiz da extensão (pra resolver caminho do bin/yt-dlp.exe embutido).
// Deriva de $.fileName (= caminho do index.jsx rodando), 2 níveis acima.
function getExtensionDir() {
    try {
        var hostFile = new File($.fileName);
        var root = hostFile.parent.parent; // host/index.jsx → host/ → raiz
        return JSON.stringify({ dir: root.fsName });
    } catch (e) { return JSON.stringify({ dir: "", error: e.message }); }
}

// Acha um clip na timeline cujo nome contém nameSub e que começa perto de startSec.
// Procura em todas as video tracks (evita confusão de índice de track).
function findClipByNameNearStart(seq, nameSub, startSec, tolSec) {
    var startTicks = startSec * TICKS_PER_SECOND;
    var tol = (tolSec || 0.6) * TICKS_PER_SECOND;
    var best = null, bestDelta = tol;
    try {
        for (var t = 0; t < seq.videoTracks.numTracks; t++) {
            var tr = seq.videoTracks[t];
            for (var c = 0; c < tr.clips.numItems; c++) {
                var clp = tr.clips[c];
                var nm = "";
                try { nm = (clp.name || "").toUpperCase(); } catch (eNm) {}
                if (nameSub && nm.indexOf(nameSub) < 0) continue;
                var cs = 0;
                try { cs = parseFloat(clp.start.ticks); } catch (eCs) { continue; }
                var delta = Math.abs(cs - startTicks);
                if (delta <= bestDelta) { best = clp; bestDelta = delta; }
            }
        }
    } catch (e) {}
    return best;
}

// Estica o clip do PRECO de cada produto até o início do próximo produto, fechando
// o buraco causado pela narração entre o fim do preço e a intro seguinte. O limite
// é o conteúdo interno do template PRECO (a reserva). Só ESTENDE (nunca encurta).
function stretchPrecoToNextProduct(seq, products, ctaStarts) {
    var log = [];
    try {
        var precoContentDur = templateContentDuration("PRECO");
        if (!(precoContentDur > 0)) { log.push("conteúdo do PRECO não medido — esticamento pulado"); return log; }

        function itemTime(it) { return (it.time_seconds == null) ? null : it.time_seconds + (it.offset_seconds ? it.offset_seconds : 0); }
        // Menor CTA dentro de (a, b), pra o PRECO parar nele (não invadir o CTA).
        function nearestCtaBetween(a, b) {
            var best = null;
            if (ctaStarts) for (var k = 0; k < ctaStarts.length; k++) {
                var c = ctaStarts[k];
                if (c > a + 0.05 && c < b && (best === null || c < best)) best = c;
            }
            return best;
        }

        for (var p = 0; p < products.length - 1; p++) {
            // PRECO deste produto
            var precoSec = null;
            var pit = products[p].timeline || [];
            for (var i = 0; i < pit.length; i++) {
                if ((pit[i].template || "").toUpperCase() === "PRECO") { var t = itemTime(pit[i]); if (t != null) precoSec = t; }
            }
            if (precoSec === null) continue;

            // Início do PRÓXIMO produto = card PRODUTO seguinte
            var nextStart = null;
            var nit = products[p + 1].timeline || [];
            for (var j = 0; j < nit.length; j++) {
                if ((nit[j].template || "").toUpperCase() === "PRODUTO") {
                    var ns = itemTime(nit[j]);
                    if (ns != null && (nextStart === null || ns < nextStart)) nextStart = ns;
                }
            }
            if (nextStart === null) continue;

            var clip = findClipByNameNearStart(seq, "PRECO", precoSec, 0.6);
            if (!clip) { log.push("p" + (p + 1) + ": clip PRECO não localizado @ " + precoSec.toFixed(2) + "s"); continue; }

            var curEndSec = 0;
            try { curEndSec = parseFloat(clip.end.ticks) / TICKS_PER_SECOND; } catch (eCe) {}
            var maxEndSec = precoSec + precoContentDur;
            // Se tem um CTA entre o PRECO e o próximo produto, o PRECO PARA no CTA
            // (o stock do CTA assume dali até o próximo produto).
            var cta = nearestCtaBetween(precoSec, nextStart);
            var limit = (cta !== null) ? cta : nextStart;
            var targetEnd = Math.min(limit, maxEndSec);
            // Se um CTA exige encurtar o PRECO (clip atual passa do CTA), corta.
            if (cta !== null && curEndSec > cta + 0.04) {
                try {
                    var ct = new Time(); ct.ticks = toTicks(cta);
                    clip.end = ct;
                    log.push("p" + (p + 1) + ": PRECO cortado em " + cta.toFixed(2) + "s (CTA assume daqui)");
                    continue;
                } catch (eCut) { log.push("p" + (p + 1) + ": falha ao cortar PRECO no CTA: " + eCut.message); }
            }

            if (targetEnd > curEndSec + 0.04) { // só estende (tolerância ~1 frame)
                try {
                    var et = new Time();
                    et.ticks = toTicks(targetEnd);
                    clip.end = et;
                    var newEndSec = parseFloat(clip.end.ticks) / TICKS_PER_SECOND;
                    var gapLeft = limit - newEndSec;
                    log.push("p" + (p + 1) + ": PRECO " + curEndSec.toFixed(2) + "s → " + newEndSec.toFixed(2) +
                             "s (alvo " + limit.toFixed(2) + "s" + (cta !== null ? " [CTA]" : " [próx produto]") +
                             (gapLeft > 0.1 && cta === null ? ("; AINDA sobra " + gapLeft.toFixed(2) + "s — aumente a reserva do [TEMPLATE]PRECO") : "") + ")");
                } catch (eExt) {
                    log.push("p" + (p + 1) + ": falha ao esticar PRECO: " + eExt.message);
                }
            } else {
                log.push("p" + (p + 1) + ": PRECO já cobre o gap (fim " + curEndSec.toFixed(2) + "s ≥ próx " + nextStart.toFixed(2) + "s)");
            }
        }
    } catch (e) { log.push("erro no esticamento do PRECO: " + e.message); }
    return log;
}

// Ajusta a velocidade de um clip (via QE) pra durar targetDur. Acha o clip QE
// pelo NOME (mais confiável que por tempo) perto de startSec, em qualquer track.
// Retorna string com o resultado/erro pra diagnóstico.
function setClipSpeedToFit(nameSub, startSec, naturalDur, targetDur) {
    if (!(naturalDur > 0) || !(targetDur > 0)) return "args inválidos";
    try {
        if (typeof app.enableQE === "function") app.enableQE();
        var qeSeq = qe.project.getActiveSequence();
        if (!qeSeq) return "sem qeSeq";
        var ratio = naturalDur / targetDur; // <1 deixa o clip mais lento (dura mais)
        var nsub = String(nameSub || "").toUpperCase();
        var startTicks = startSec * TICKS_PER_SECOND;
        var numTr = 0;
        try { numTr = qeSeq.numVideoTracks; } catch (eN) {}
        for (var tr = 0; tr < numTr; tr++) {
            var qt = null;
            try { qt = qeSeq.getVideoTrackAt(tr); } catch (eT) {}
            if (!qt) continue;
            var ni = 0;
            try { ni = qt.numItems; } catch (eNi) {}
            for (var c = 0; c < ni; c++) {
                var qc = null;
                try { qc = qt.getItemAt(c); } catch (eG) {}
                if (!qc) continue;
                var nm = "";
                try { nm = (qc.name || "").toUpperCase(); } catch (eNm) {}
                if (!nm || (nsub && nm.indexOf(nsub) < 0)) continue;
                // confere o tempo aproximado pra pegar a instância certa
                var cs = NaN;
                try { cs = parseFloat(qc.start.ticks) / TICKS_PER_SECOND; } catch (e1) {}
                if (isNaN(cs)) { try { cs = parseFloat(qc.start.secs); } catch (e2) {} }
                if (!isNaN(cs) && Math.abs(cs - startSec) > 1.0) continue;
                // Tenta as assinaturas conhecidas de setSpeed (varia entre versões).
                try { qc.setSpeed(ratio); return "ok(ratio=" + ratio.toFixed(3) + ")"; } catch (e3) {}
                try { qc.setSpeed(ratio * 100); return "ok(pct=" + (ratio * 100).toFixed(1) + ")"; } catch (e4) {}
                try {
                    var dt = new Time(); dt.ticks = toTicks(targetDur);
                    qc.setSpeed(ratio, dt.ticks, false, false, false); return "ok(ratio+dur)";
                } catch (e5) { return "setSpeed lançou: " + (e5 && e5.message ? e5.message : "?"); }
            }
        }
        return "clip QE não achado (nome '" + nsub + "' @ " + startSec.toFixed(1) + "s)";
    } catch (e) { return "exceção: " + (e && e.message ? e.message : "?"); }
}

// Ajusta a duração dos MOGRTs de ponto-chave (ex: LIKE) pra durar até o próximo
// produto: se o clip for maior que a janela, corta (clip.end); se for menor,
// estica via speed/duration (QE). `fits` = [{time, track, target, name}].
function fitKeyPointMogrts(seq, fits) {
    var out = [];
    if (!fits || !fits.length) return out;
    for (var i = 0; i < fits.length; i++) {
        var f = fits[i];
        if (!(f.target > 0)) continue;
        var clip = findClipByNameNearStart(seq, String(f.name || "").toUpperCase(), f.time, 0.8);
        if (!clip) { out.push("fit " + (f.name || "?") + ": clip não localizado @ " + f.time.toFixed(1) + "s"); continue; }
        var cs = 0, ce = 0;
        try { cs = parseFloat(clip.start.ticks) / TICKS_PER_SECOND; } catch (e1) {}
        try { ce = parseFloat(clip.end.ticks) / TICKS_PER_SECOND; } catch (e2) {}
        var natural = ce - cs;
        if (!(natural > 0)) continue;

        if (natural > f.target + 0.04) {
            // Maior que a janela → corta pra não invadir a introdução do produto.
            try {
                var et = new Time(); et.ticks = toTicks(cs + f.target);
                clip.end = et;
                out.push("fit " + f.name + ": corte " + natural.toFixed(2) + "s → " + f.target.toFixed(2) + "s");
            } catch (eT) { out.push("fit " + f.name + " corte err: " + eT.message); }
        } else if (natural < f.target - 0.04) {
            // Menor que a janela → estica via speed/duration.
            var res = setClipSpeedToFit(f.name, cs, natural, f.target);
            out.push("fit " + f.name + ": speed/duration " + natural.toFixed(2) + "s → " + f.target.toFixed(2) + "s [" + res + "]");
        } else {
            out.push("fit " + f.name + ": já cabe (" + natural.toFixed(2) + "s)");
        }
    }
    return out;
}

// ─── MONTAGEM PRINCIPAL ───────────────────────────────────────────────────────

function mountFromJSON(jsonString) {
    try {
        var data = eval("(" + jsonString + ")");
        var seq  = app.project.activeSequence;
        if (!seq) return JSON.stringify({ error: "Nenhuma sequência ativa." });

        // Reset da track de SFX — cada mount resolve uma track nova de SFX
        // (criada no final) e reusa pra todas as transições.
        _sfxAudioTrackIdx = -1;

        // Suporta { products: [...] } e formato legado { product, timeline }
        var products = [];
        if (data.products && data.products.length) {
            products = data.products;
        } else {
            var single = data.product || {};
            single.timeline = data.timeline || [];
            products = [single];
        }

        var results = [];

        // Mede 1x as durações dos cards (mesmos templates pra todos os produtos)
        var _introDur = measureTemplateDuration("PRODUTO");
        var _precoDur = measureTemplateDuration("PRECO");
        if (_introDur <= 0) _introDur = 5;
        if (_precoDur <= 0) _precoDur = 5;

        for (var p = 0; p < products.length; p++) {
            var product = products[p];
            var items   = product.timeline || [];

            // ── CLAMP: lower thirds NÃO podem cair sobre o card de introdução
            // (PRODUTO) nem sobre o card de preço (PRECO). As imagens rodam junto
            // com a intro, então a zona proibida é o tempo em que cada CARD está
            // na tela. LT que invade é empurrada pra fora da janela.
            (function clampLowerThirds() {
                var introStart = null, precoStart = null;
                for (var ci = 0; ci < items.length; ci++) {
                    var it = items[ci];
                    if (!it || it.type !== "template_insert" || it.time_seconds == null) continue;
                    var tn = (it.template || "").toUpperCase();
                    var ts = it.time_seconds + (it.offset_seconds || 0);
                    if (tn === "PRODUTO" && introStart === null) introStart = ts;
                    if (tn === "PRECO"   && precoStart === null) precoStart = ts;
                }
                var introEnd = (introStart !== null) ? introStart + _introDur : null;

                for (var li = 0; li < items.length; li++) {
                    var lt = items[li];
                    if (!lt || lt.type !== "template_insert" || lt.time_seconds == null) continue;
                    if (lt._recap) continue; // recap final: posição já é definitiva
                    var isLT = (lt._ltIndex !== undefined) ||
                               ((lt.template || "").toUpperCase() === "LOWERTHIRD");
                    if (!isLT) continue;

                    var ltDur = (lt.duration != null) ? lt.duration : 4;
                    var s = lt.time_seconds;
                    var orig = s;
                    var moved = false;

                    // sobrepõe o card de introdução? → empurra pro fim do card
                    if (introStart !== null && s < introEnd && (s + ltDur) > introStart) {
                        s = introEnd; moved = true;
                    }
                    // sobrepõe o card de preço? → termina antes do card começar
                    if (precoStart !== null && (s + ltDur) > precoStart && s < (precoStart + _precoDur)) {
                        s = precoStart - ltDur;
                        if (introEnd !== null && s < introEnd) s = introEnd;
                        moved = true;
                    }

                    if (moved) {
                        lt.time_seconds = s;
                        results.push({ product: p, index: li, type: "lt_clamp", success: true,
                            note: "LT movida " + orig.toFixed(2) + "s → " + s.toFixed(2) + "s (fora de intro/preço)" });
                    }
                }
            })();

            for (var i = 0; i < items.length; i++) {
                var item = items[i];

                if (item.time_seconds === undefined || item.time_seconds === null) {
                    results.push({ product: p, index: i, type: item.type, success: false, error: "time_seconds não resolvido." });
                    continue;
                }

                var trackIdx  = item.track    !== undefined ? item.track    : 1;
                var duration  = item.duration !== undefined ? item.duration : 4;
                var animation = item.animation || "zoom_in";
                var r;

                // offset_seconds: fine-tune universal do ponto de inserção.
                // Negativo = insere mais cedo (útil pra transições e ajustes
                // finos de timing sem mexer no transcript).
                var startSec = item.time_seconds;
                if (item.offset_seconds !== undefined && item.offset_seconds !== null) {
                    startSec += item.offset_seconds;
                    if (startSec < 0) startSec = 0;
                }

                try {
                    if (item.type === "product_video") {
                        // Vídeo do produto (bin PROD_N) — insere por nome, corta na duração, sem áudio.
                        r = JSON.parse(insertBinClipAtTime(item.bin_name, trackIdx, startSec, duration, item.src_w, item.src_h, false));

                    } else if (item.bin_name) {
                        // Imagem vinda do bin PROD_N (modelo novo) — insere por nome, duração exata.
                        r = JSON.parse(insertBinClipAtTime(item.bin_name, trackIdx, startSec, duration, item.src_w, item.src_h, true));

                    } else if (item.type === "product_image" || item.type === "stock_image") {
                        // Imagem por ARQUIVO (stock do CTA, ou modo legado).
                        if (item._mogrt_wrapper) {
                            r = JSON.parse(insertMOGRTWithImage(
                                item._mogrt_wrapper,
                                item.file,
                                item._mogrt_slot || null,
                                startSec,
                                duration,
                                trackIdx
                            ));
                        } else {
                            r = JSON.parse(insertMediaAtTime(item.file, trackIdx, startSec, duration, animation, item.src_w, item.src_h));
                        }

                    } else if (item.type === "template_insert") {
                        // LOWERTHIRD e templates com text_overrides recebem extras (texto custom + sufixo de naming)
                        // _expand vem da lista de templates marcados como "expandir na timeline" (aba Templates)
                        // anchor="cut" (transições): alinha o corte interno do template
                        // ao timestamp e auto-ativa expand (a âncora só funciona expandindo).
                        var itemAnchor = item.anchor || null;
                        var extras = null;
                        if (item.text_overrides || item._ltIndex !== undefined || item._expand || itemAnchor) {
                            extras = {
                                textOverrides:  item.text_overrides || null,
                                copyNameSuffix: item._ltIndex !== undefined ? ("lt" + item._ltIndex) : "",
                                expand:         !!item._expand || (itemAnchor === "cut") || (itemAnchor === "marker"),
                                anchor:         itemAnchor
                            };
                        }
                        r = JSON.parse(insertTemplate(item.template, trackIdx, startSec, product, extras));

                    } else {
                        r = { error: "Tipo não suportado: " + item.type };
                    }
                } catch (itemErr) {
                    r = { error: itemErr.message };
                }

                results.push({
                    product:       p,
                    index:         i,
                    type:          item.type,
                    success:       !r.error,
                    error:         r.error         || null,
                    updateLog:     r.updateLog     || null,
                    scaleToFrame:  r.scaleToFrame  || null,
                    blurBg:        r.blurBg        || null,
                    animation:     r.animation     || null,
                    mogrt:         r.mogrt         || false,
                    mediaReplaced: r.mediaReplaced || false,
                    masterclip:    r.masterclip    || false,
                    expanded:      r.expanded      || false
                });
            }
        }

        var errors = 0;
        for (var j = 0; j < results.length; j++) { if (!results[j].success) errors++; }

        // ── ESTICA PRECO até o próximo produto (fecha buracos da narração) ─────
        var precoStretchLog = [];
        try {
            precoStretchLog = stretchPrecoToNextProduct(seq, products, data.cta_starts || null);
        } catch (eStr) { precoStretchLog = ["erro: " + eStr.message]; }

        // ── AJUSTA duração dos MOGRTs de ponto-chave (LIKE) até o próximo produto ─
        var keyPointFitLog = [];
        try {
            if (data.key_point_fits && data.key_point_fits.length) {
                keyPointFitLog = fitKeyPointMogrts(seq, data.key_point_fits);
            }
        } catch (eKf) { keyPointFitLog = ["erro: " + eKf.message]; }

        // ── CAPÍTULOS (YouTube) + marcadores de sequência ──────────────────────
        var chapters = [];
        var chaptersLog = [];
        try {
            // Título da conclusão: data.conclusion pode ser string, {title:...} ou false (desliga)
            var conclTitle = null;
            if (data.conclusion === false) conclTitle = false;
            else if (typeof data.conclusion === "string") conclTitle = data.conclusion;
            else if (data.conclusion && data.conclusion.title) conclTitle = data.conclusion.title;

            chapters = buildChaptersList(products, _precoDur, conclTitle);

            // Recria marcadores: limpa os antigos e cria um por capítulo.
            var removedMk = clearSequenceMarkers(seq);
            if (removedMk > 0) chaptersLog.push("Marcadores antigos removidos: " + removedMk);
            var created = 0;
            for (var ch = 0; ch < chapters.length; ch++) {
                try {
                    var mk = seq.markers.createMarker(chapters[ch].time);
                    try { mk.name = chapters[ch].title; } catch (eNm) {}
                    try { mk.comments = chapters[ch].title; } catch (eCm) {}
                    created++;
                } catch (eMk) {
                    chaptersLog.push("Falha ao criar marcador @ " + chapters[ch].time.toFixed(2) + "s: " + eMk.message);
                }
            }
            chaptersLog.push("Capítulos: " + chapters.length + " | marcadores criados: " + created);
        } catch (eCh) {
            chaptersLog.push("Erro ao gerar capítulos: " + eCh.message);
        }

        return JSON.stringify({ success: true, total: results.length, errors: errors, results: results,
                                chapters: chapters, chaptersLog: chaptersLog, precoStretchLog: precoStretchLog,
                                keyPointFitLog: keyPointFitLog });
    } catch (e) {
        return JSON.stringify({ error: e.message });
    }
}
