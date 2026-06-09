const CACHE_NAME = "ledger-pilot-v9";
const ASSETS = ["./", "./index.html", "./styles.css", "./app.js", "./manifest.webmanifest"];
const SHARE_DB_NAME = "ledgerPilot.shareTarget.v1";
const SHARE_STORE = "incomingScreenshots";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === "POST" && url.searchParams.has("shared")) {
    event.respondWith(handleShareTarget(event.request));
    return;
  }

  if (event.request.method !== "GET") return;
  if (event.request.mode === "navigate" || event.request.destination === "document") {
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request).then((cached) => cached || caches.match("./index.html"))));
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
      return response;
    })),
  );
});

async function handleShareTarget(request) {
  try {
    const form = await request.formData();
    const files = [];

    for (const value of form.values()) {
      if (value && typeof value === "object" && String(value.type || "").startsWith("image/")) files.push(value);
    }

    if (files.length) {
      await saveSharedScreenshots(files);
      return redirectTo("./index.html?shared=1");
    }

    const text = [form.get("title"), form.get("text"), form.get("url")]
      .filter(Boolean)
      .join("\n")
      .trim();
    if (text) {
      return redirectTo(`./index.html?intent=ocr&text=${encodeURIComponent(text)}`);
    }
  } catch {
    return redirectTo("./index.html?shared=1");
  }

  return redirectTo("./index.html");
}

function redirectTo(path) {
  return Response.redirect(new URL(path, self.registration.scope).href, 303);
}

async function saveSharedScreenshots(files) {
  const db = await openShareDb();
  const tx = db.transaction(SHARE_STORE, "readwrite");
  const store = tx.objectStore(SHARE_STORE);

  files.forEach((file, index) => {
    store.put({
      id: `${Date.now()}_${index}_${Math.random().toString(16).slice(2)}`,
      name: file.name || `shared-screenshot-${index + 1}`,
      type: file.type || "image/png",
      size: file.size || 0,
      file,
      source: "ocr",
      createdAt: new Date().toISOString(),
    });
  });

  await txDone(tx);
  db.close();
}

function openShareDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SHARE_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SHARE_STORE)) db.createObjectStore(SHARE_STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
