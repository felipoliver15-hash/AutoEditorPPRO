// Pexels API integration

var Pexels = (function () {
    var BASE = "https://api.pexels.com";

    function getKey() {
        return localStorage.getItem("pexels_api_key") || "";
    }

    function headers() {
        return { Authorization: getKey() };
    }

    function searchVideos(query, perPage, callback) {
        if (!getKey()) return callback({ error: "API Key do Pexels não configurada." });
        perPage = perPage || 9;
        var url = BASE + "/videos/search?query=" + encodeURIComponent(query) + "&per_page=" + perPage + "&orientation=landscape";
        fetch(url, { headers: headers() })
            .then(function (r) { return r.json(); })
            .then(function (data) { callback(null, data); })
            .catch(function (e) { callback({ error: e.message }); });
    }

    function searchPhotos(query, perPage, callback) {
        if (!getKey()) return callback({ error: "API Key do Pexels não configurada." });
        perPage = perPage || 9;
        var url = BASE + "/v1/search?query=" + encodeURIComponent(query) + "&per_page=" + perPage + "&orientation=landscape";
        fetch(url, { headers: headers() })
            .then(function (r) { return r.json(); })
            .then(function (data) { callback(null, data); })
            .catch(function (e) { callback({ error: e.message }); });
    }

    // Faz download do arquivo para a pasta de destino e retorna o caminho local
    // No CEP com --enable-nodejs podemos usar fetch + fs
    function downloadFile(url, destFolder, filename, callback) {
        try {
            var fs   = require("fs");
            var path = require("path");
            var http = url.startsWith("https") ? require("https") : require("http");

            if (!fs.existsSync(destFolder)) fs.mkdirSync(destFolder, { recursive: true });
            var dest = path.join(destFolder, filename);
            var file = fs.createWriteStream(dest);

            http.get(url, function (response) {
                response.pipe(file);
                file.on("finish", function () {
                    file.close(function () { callback(null, dest); });
                });
            }).on("error", function (e) {
                fs.unlink(dest, function () {});
                callback({ error: e.message });
            });
        } catch (e) {
            callback({ error: "Node.js indisponível: " + e.message });
        }
    }

    return { searchVideos: searchVideos, searchPhotos: searchPhotos, downloadFile: downloadFile };
})();
