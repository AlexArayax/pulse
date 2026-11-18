'use strict';

const workerUrl = new URL(self.location.href);
const rootUrl = new URL('./', workerUrl);

const version = workerUrl.searchParams.get('v') || '1';

const assetsBase = new URL(
    workerUrl.searchParams.get('assets') || './',
    rootUrl
);

const routerUrl = new URL(
    workerUrl.searchParams.get('router') || 'erp.php',
    rootUrl
);

if (
    assetsBase.origin !== self.location.origin ||
    routerUrl.origin !== self.location.origin
) {
    throw new Error('ERP resources must be same-origin');
}

// Отдельное пространство имён для каждой установки ERP.
const CACHE_PREFIX =
    `personal-erp-offline:${rootUrl.pathname}:`;

const CACHE =
    `${CACHE_PREFIX}${encodeURIComponent(version)}`;

function asset(path) {
    return new URL(path, assetsBase).href;
}

function versioned(path) {
    const url = new URL(path, assetsBase);
    url.searchParams.set('v', version);
    return url.href;
}

const OFFLINE_URL = new URL('offline.html', rootUrl).href;

const REQUIRED_FILES = [
    OFFLINE_URL,
    versioned('assets/app.js'),
    versioned('assets/app.css'),
];

const OPTIONAL_FILES = [
    versioned('modules/initial.js'),
    versioned('modules/initial.css'),
];

function isAllowedStatic(url) {
    if (url.origin !== self.location.origin) {
        return false;
    }

    const directories = [
        'assets/',
        'modules/',
        'vendor/',
    ].map(path => new URL(path, assetsBase).pathname);

    return directories.some(path =>
        url.pathname.startsWith(path)
    ) && /\.(?:js|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf)$/i
        .test(url.pathname);
}

function isValidStaticResponse(response) {
    const contentType =
        response.headers.get('Content-Type') || '';

    return (
        response.ok &&
        response.type === 'basic' &&
        !contentType.toLowerCase().includes('text/html')
    );
}

async function saveRequired(cache, url) {
    const response = await fetch(url, {
        cache: 'reload',
        credentials: 'same-origin',
    });

    if (!response.ok) {
        throw new Error(`Cannot precache ${url}`);
    }

    if (
        url !== OFFLINE_URL &&
        !isValidStaticResponse(response)
    ) {
        throw new Error(`Invalid static response: ${url}`);
    }

    await cache.put(url, response);
}

async function saveOptional(cache, url) {
    try {
        const response = await fetch(url, {
            cache: 'reload',
            credentials: 'same-origin',
        });

        if (isValidStaticResponse(response)) {
            await cache.put(url, response);
        }
    } catch {
        // Необязательный файл можно загрузить позднее.
    }
}

self.addEventListener('install', event => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE);

        await Promise.all(
            REQUIRED_FILES.map(url => saveRequired(cache, url))
        );

        await Promise.all(
            OPTIONAL_FILES.map(url => saveOptional(cache, url))
        );

    })());
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const keys = await caches.keys();

        await Promise.all(
            keys
                .filter(key =>
                    key.startsWith(CACHE_PREFIX) &&
                    key !== CACHE
                )
                .map(key => caches.delete(key))
        );

        await self.clients.claim();
    })());
});

self.addEventListener('fetch', event => {
    const request = event.request;
    const url = new URL(request.url);

    if (
        request.method !== 'GET' ||
        url.origin !== self.location.origin
    ) {
        return;
    }


    if (request.mode === 'navigate') {
        if (
            url.pathname !== routerUrl.pathname ||
            url.searchParams.has('action')
        ) {
            return;
        }

        event.respondWith((async () => {
            try {
 
                return await fetch(request);
            } catch {
                const cache = await caches.open(CACHE);
                const shell = await cache.match(OFFLINE_URL);

                return shell || new Response(
                    'Автономная версия ещё не подготовлена.',
                    {
                        status: 503,
                        headers: {
                            'Content-Type':
                                'text/plain; charset=utf-8',
                        },
                    }
                );
            }
        })());

        return;
    }

    if (!isAllowedStatic(url)) {
        return;
    }

    event.respondWith((async () => {
        const cache = await caches.open(CACHE);
        const cached = await cache.match(request);

        if (cached) {
            return cached;
        }

        const response = await fetch(request);

        if (isValidStaticResponse(response)) {
            try {
                await cache.put(request, response.clone());
            } catch (error) {
                console.warn('ERP static cache write failed', error);
            }
        }

        return response;
    })());
});


self.addEventListener('message', event => {
    if (event.data?.type !== 'ERP_CACHE_URLS') {
        return;
    }

    const urls = Array.isArray(event.data.urls)
        ? event.data.urls
        : [];

    event.waitUntil((async () => {
        const cache = await caches.open(CACHE);

        await Promise.all(
            urls.map(async value => {
                try {
                    const url = new URL(value, rootUrl);

                    if (!isAllowedStatic(url)) {
                        return;
                    }

                    if (await cache.match(url.href)) {
                        return;
                    }

                    await saveOptional(cache, url.href);
                } catch {
                }
            })
        );
    })());
});