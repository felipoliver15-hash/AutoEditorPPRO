/**
 * CSInterface - Adobe CEP bridge (minimal, funcional para este plugin)
 * Fonte completa: https://github.com/Adobe-CEP/CEP-Resources
 */

var CSInterface = function () {
    this._hostEnvironment = window.__adobe_cep__
        ? JSON.parse(window.__adobe_cep__.getHostEnvironment())
        : null;
};

CSInterface.SystemPath = {
    USER_DATA:    "userData",
    COMMON_FILES: "commonFiles",
    MY_DOCUMENTS: "myDocuments",
    APPLICATION:  "application",
    EXTENSION:    "extension",
    DESKTOP:      "desktop",
    TEMP:         "temp"
};

CSInterface.prototype.getHostEnvironment = function () {
    return this._hostEnvironment;
};

CSInterface.prototype.getSystemPath = function (pathType) {
    if (!window.__adobe_cep__) return "";
    var result = decodeURI(window.__adobe_cep__.getSystemPath(pathType));
    // Remove prefixo file:/// no Windows
    return result.replace(/^file:\/\/\//, "").replace(/\//g, "\\");
};

CSInterface.prototype.evalScript = function (script, callback) {
    if (!window.__adobe_cep__) {
        console.warn("[CSInterface] Não está rodando dentro do CEP.");
        if (callback) callback("null");
        return;
    }
    window.__adobe_cep__.evalScript(script, callback || function () {});
};

CSInterface.prototype.addEventListener = function (type, listener) {
    if (!window.__adobe_cep__) return;
    window.__adobe_cep__.addEventListener(type, listener);
};

CSInterface.prototype.dispatchEvent = function (event) {
    if (!window.__adobe_cep__) return;
    window.__adobe_cep__.dispatchEvent(event);
};

CSInterface.prototype.getExtensionID = function () {
    return window.__adobe_cep__
        ? JSON.parse(window.__adobe_cep__.getCurrentApiVersion()).extensionId
        : "dev";
};
