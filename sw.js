/* ================= 无怨导航页 Service Worker =================
 * 缓存策略：
 *  - CSS / JS / 图片 / 图标（css/js/png/jpg/jpeg/webp/svg/ico/gif/woff2 等）：缓存 30 天
 *  - MP3 等音频（mp3/m4a/wav/ogg/aac/flac/opus）：缓存 7 天
 *  - 页面导航：network-first（保证版本更新能生效）
 *  - 其余未知请求：直接走网络
 * 说明：需 HTTPS（或 localhost）环境才能注册；file:// 直接打开时浏览器会静默跳过。
 */
var SW_VERSION = 'wuyuan-sw-v1';
var STATIC_CACHE = SW_VERSION + '-static';
var AUDIO_CACHE = SW_VERSION + '-audio';
var STATIC_MAX_AGE = 30 * 24 * 60 * 60 * 1000;  /* 30 天 */
var AUDIO_MAX_AGE = 7 * 24 * 60 * 60 * 1000;   /* 7 天 */
var TS_SUFFIX = '#sw-ts';                      /* 时间戳条目后缀（不进网络） */

self.addEventListener('install', function(e){
    e.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', function(e){
    e.waitUntil(
        caches.keys().then(function(keys){
            return Promise.all(keys.map(function(k){
                if(k.indexOf('wuyuan-sw-') === 0 && k !== SW_VERSION){
                    return caches.delete(k);
                }
            }));
        }).then(function(){ return self.clients.claim(); })
    );
});

function isAudio(url){
    return /\.(mp3|m4a|wav|ogg|aac|flac|opus)(\?|#|$)/i.test(url.pathname + url.search);
}
function isStatic(url){
    return /\.(css|js|mjs|png|jpe?g|webp|svg|ico|gif|woff2?|ttf|eot|otf)(\?|#|$)/i.test(url.pathname + url.search);
}

/* 时间戳写入：在同一个 cache 中为资源额外存一条 "url#sw-ts" 条目，避免给 opaque 响应加头 */
function putWithTime(cacheName, request, response){
    return caches.open(cacheName).then(function(cache){
        return cache.put(request, response.clone()).then(function(){
            var tsReq = new Request(request.url + TS_SUFFIX);
            var tsResp = new Response(String(Date.now()), { headers: { 'Content-Type': 'text/plain' } });
            return cache.put(tsReq, tsResp);
        });
    });
}
function getTime(cache, request){
    var tsReq = new Request(request.url + TS_SUFFIX);
    return cache.match(tsReq).then(function(r){
        if(!r) return null;
        return r.text().then(Number);
    });
}
function cacheFresh(cache, request, maxAge){
    return cache.match(request).then(function(resp){
        if(!resp) return null;
        return getTime(cache, request).then(function(ts){
            if(ts == null) return resp;                 /* 无时间戳的旧缓存：直接使用 */
            if(Date.now() - ts > maxAge) return null;   /* 已过期 */
            return resp;
        });
    });
}
/* 跨域音频可能无 CORS 头：先按 cors 请求，失败再退 no-cors（opaque）缓存 */
function fetchAny(req){
    return fetch(req).catch(function(){
        return fetch(req.clone(), { mode: 'no-cors' });
    });
}

self.addEventListener('fetch', function(e){
    var req = e.request;
    if(req.method !== 'GET') return;
    var url;
    try{ url = new URL(req.url); }catch(err){ return; }
    if(/^(data|blob|file):/.test(url.protocol)) return;

    /* 任何缓存逻辑出错都不影响页面：回退到浏览器默认网络 */
    function guarded(p){
        return Promise.resolve(p).catch(function(err){
            console.error('[sw-error]', req.url, err && err.message || err);
            return null;
        });
    }

    /* ---- 音频：缓存优先，7 天过期 ---- */
    if(isAudio(url)){
        e.respondWith(
            guarded(caches.open(AUDIO_CACHE).then(function(cache){
                return cacheFresh(cache, req, AUDIO_MAX_AGE).then(function(cached){
                    if(cached) return cached;
                    return fetchAny(req).then(function(resp){
                        if(resp && (resp.ok || resp.type === 'opaque')){
                            return putWithTime(AUDIO_CACHE, req, resp).then(function(){ return resp; });
                        }
                        return resp;
                    }).catch(function(){
                        return cache.match(req);   /* 网络失败回退旧缓存 */
                    });
                });
            }))
        );
        return;
    }

    /* ---- 同源静态资源：stale-while-revalidate，30 天 ---- */
    if(isStatic(url) && url.origin === self.location.origin){
        e.respondWith(
            guarded(caches.open(STATIC_CACHE).then(function(cache){
                return cacheFresh(cache, req, STATIC_MAX_AGE).then(function(cached){
                    var network = fetch(req).then(function(resp){
                        if(resp && resp.ok) return putWithTime(STATIC_CACHE, req, resp).then(function(){ return resp; });
                        return resp;
                    }).catch(function(){ return cached; });
                    return cached || network;
                });
            }))
        );
        return;
    }

    /* ---- 页面导航：network-first，保证版本更新能生效 ---- */
    if(req.mode === 'navigate'){
        e.respondWith(
            guarded(fetch(req).then(function(resp){
                if(resp && resp.ok) return putWithTime(STATIC_CACHE, req, resp).then(function(){ return resp; });
                return resp;
            }).catch(function(){
                return caches.match(req).then(function(c){
                    if(c) return c;
                    return caches.match('/index.html').then(function(idx){ return idx || Response.error(); });
                });
            }))
        );
        return;
    }

    /* ---- 其余请求：走默认网络 ---- */
});
