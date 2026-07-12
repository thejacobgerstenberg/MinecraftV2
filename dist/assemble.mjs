// assemble.mjs — fold the esbuild IIFE bundle + inlined assets + a fetch/WS
// shim into a single self-contained dist/loomfall.html that runs under file://
// with ZERO network requests.
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';

const BUILD = '/tmp/claude-0/-home-user-MinecraftV2/04ddf0be-7d6d-5fd2-8d4b-0a801ef56ca9/scratchpad/buildsrc';
const BUNDLE = '/tmp/claude-0/-home-user-MinecraftV2/04ddf0be-7d6d-5fd2-8d4b-0a801ef56ca9/scratchpad/bundle.js';
const OUT_DIR = '/home/user/MinecraftV2/dist';
const OUT = join(OUT_DIR, 'loomfall.html');

const read = (p) => readFileSync(p, 'utf8');
const b64 = (p) => readFileSync(p).toString('base64');
// Neutralize any literal </script> that would prematurely close our inline tag.
const scriptSafe = (s) => s.replace(/<\/script/gi, '<\\/script');

// --- 1. index.html --------------------------------------------------------
let html = read(join(BUILD, 'index.html'));

// --- 2. strip importmap, module entry, both stylesheet links --------------
html = html.replace(/<script type="importmap">[\s\S]*?<\/script>/i, '');
html = html.replace(/<script type="module" src="\.\/src\/main\.js"><\/script>/i, '');
html = html.replace(/<link rel="stylesheet" href="\.\/css\/style\.css"\s*\/>/i, '');
html = html.replace(/<link rel="stylesheet" href="\.\/ui-kit\/components\/toast\.css"\s*\/>/i, '');

// --- 3. inline ALL CSS ----------------------------------------------------
// Order mirrors the original cascade: page stylesheets first, then the ui-kit
// design tokens/base, brand theme + fixes, then every component + ux stylesheet
// (which HudKit/OptionsStore used to inject as runtime <link>s — now no-ops).
const componentCss = readdirSync(join(BUILD, 'ui-kit/components'))
  .filter((f) => f.endsWith('.css'))
  .map((f) => join('ui-kit/components', f));
const uxCss = [
  'ux/captions/captions.css',
  'ux/keybinds/keybinds.css',
  'ux/onboarding/tutorial.css',
  'ux/options/access-options.css',
  'ux/options/cvd.css',
  'ux/options/colorblind.css',
  'ux/options/motion.css',
];
const cssFiles = [
  'css/style.css',
  'ui-kit/tokens.css',
  'ui-kit/base.css',
  'ui-integrate/brand-theme.css',
  'ui-integrate/settings-shell-fix.css',
  ...componentCss,
  ...uxCss,
];
// Strip @import lines (their targets are inlined separately) so no file://
// fetch is triggered by the concatenated stylesheet.
const css = cssFiles
  .map((rel) => '/* === ' + rel + ' === */\n' + read(join(BUILD, rel)).replace(/^\s*@import[^;]*;\s*$/gim, ''))
  .join('\n');
const styleTag = '<style>\n' + css + '\n</style>';

// --- 4. inline brand images as data URIs ----------------------------------
const wordmarkURI = 'data:image/svg+xml;base64,' + b64(join(BUILD, 'assets/brand/wordmark-dark.svg'));
const faviconURI = 'data:image/svg+xml;base64,' + b64(join(BUILD, 'assets/brand/favicon.svg'));
html = html.split('./assets/brand/wordmark-dark.svg').join(wordmarkURI);
html = html.replace(/<link rel="icon"[^>]*href="\.\/assets\/brand\/favicon\.svg"[^>]*\/>/i,
  '<link rel="icon" type="image/svg+xml" href="' + faviconURI + '" />');
// belt-and-suspenders: any remaining favicon reference
html = html.split('./assets/brand/favicon.svg').join(faviconURI);

// Insert the inlined <style> right before </head>.
html = html.replace(/<\/head>/i, styleTag + '\n</head>');

// --- 5. embedded content map (/content + /ux json & md) -------------------
const EMBEDDED = {};
function walk(absDir) {
  for (const name of readdirSync(absDir)) {
    const p = join(absDir, name);
    const st = statSync(p);
    if (st.isDirectory()) { walk(p); continue; }
    const ext = extname(p).toLowerCase();
    if (ext !== '.json' && ext !== '.md') continue;
    const key = '/' + p.slice(BUILD.length + 1).replace(/\\/g, '/'); // e.g. /content/items.json
    EMBEDDED[key] = read(p);
  }
}
walk(join(BUILD, 'content'));
walk(join(BUILD, 'ux'));

// --- 6. PRELUDE (plain inline script, runs before the bundle) -------------
const PRELUDE = `(function(){
  "use strict";
  window.__LF_EMBEDDED = ${scriptSafe(JSON.stringify(EMBEDDED))};
  var EMB = window.__LF_EMBEDDED;
  var EMB_KEYS = Object.keys(EMB);
  function hashStr(s){var h=0;for(var i=0;i<s.length;i++)h=(h*31+s.charCodeAt(i))>>>0;return h;}
  function jsonRes(obj,status){return new Response(JSON.stringify(obj),{status:status||200,headers:{"Content-Type":"application/json"}});}
  function readWorlds(){try{var a=JSON.parse(localStorage.getItem("loomfall.worlds")||"[]");return Array.isArray(a)?a:[];}catch(e){return [];}}
  function writeWorlds(a){try{localStorage.setItem("loomfall.worlds",JSON.stringify(a));}catch(e){}}

  var _origFetch = (typeof window.fetch==="function")?window.fetch.bind(window):null;
  window.fetch = function(input, init){
    try{
      var url = (typeof input==="string") ? input : (input && input.url) || String(input);
      var method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();

      // ---- /api/worlds REST shim ----
      var apiIdx = url.indexOf("/api/worlds");
      if(apiIdx !== -1){
        var tail = url.slice(apiIdx + "/api/worlds".length);
        // strip query/hash
        var q = tail.indexOf("?"); if(q!==-1) tail = tail.slice(0,q);
        var h = tail.indexOf("#"); if(h!==-1) tail = tail.slice(0,h);
        tail = tail.replace(/\\/+$/,"");
        if(method==="POST" && (tail===""||tail==="/")){
          var body={};
          try{ if(init&&init.body) body=JSON.parse(init.body); }catch(e){ body={}; }
          var seedIn = body.seed;
          var seed;
          if(seedIn===undefined||seedIn===""||seedIn===null){ seed = Math.floor(Math.random()*2147483647); }
          else if(Number.isFinite(+seedIn)){ seed = (+seedIn)>>>0; }
          else { seed = hashStr(String(seedIn)); }
          var world={ id:"w"+Date.now().toString(36)+Math.floor(Math.random()*1e6).toString(36),
                      name:(body.name||"World"), seed:seed, createdAt:Date.now() };
          var arr=readWorlds(); arr.push(world); writeWorlds(arr);
          return Promise.resolve(jsonRes(world,200));
        }
        if(tail===""||tail==="/"){ // GET list
          return Promise.resolve(jsonRes(readWorlds(),200));
        }
        // GET /api/worlds/<id>
        var id = tail.replace(/^\\//,"");
        var found = readWorlds().find(function(w){return w&&w.id===id;});
        if(found) return Promise.resolve(jsonRes(found,200));
        return Promise.resolve(new Response('{"error":"not found"}',{status:404,headers:{"Content-Type":"application/json"}}));
      }

      // ---- embedded content/ux shim ----
      for(var i=0;i<EMB_KEYS.length;i++){
        var k=EMB_KEYS[i];
        if(url.indexOf(k)!==-1 || url.endsWith(k)){
          var ct = k.endsWith(".json") ? "application/json" : (k.endsWith(".md") ? "text/markdown" : "text/plain");
          return Promise.resolve(new Response(EMB[k],{status:200,headers:{"Content-Type":ct}}));
        }
      }

      // ---- everything else: degrade to 404 (never hit the network) ----
      return Promise.resolve(new Response("",{status:404,statusText:"Not Found (offline build)"}));
    }catch(err){
      return Promise.resolve(new Response("",{status:404}));
    }
  };

  // ---- defensive WebSocket stub (NetClient is already offline-patched) ----
  var RealWS = window.WebSocket;
  function StubWS(){ this.readyState=3; this.onopen=null; this.onmessage=null; this.onclose=null; this.onerror=null; }
  StubWS.prototype.send=function(){}; StubWS.prototype.close=function(){};
  StubWS.CONNECTING=0; StubWS.OPEN=1; StubWS.CLOSING=2; StubWS.CLOSED=3;
  try{ window.WebSocket = StubWS; }catch(e){}
  void RealWS;
})();`;

// --- 7. write dist/loomfall.html ------------------------------------------
const bundleJs = read(BUNDLE);
const finalHtml =
  html.replace(/<\/body>/i,
    '  <script>' + PRELUDE + '</script>\n' +
    '  <script>' + scriptSafe(bundleJs) + '</script>\n' +
    '</body>');

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, finalHtml);
const bytes = Buffer.byteLength(finalHtml);
console.log('WROTE ' + OUT);
console.log('BYTES ' + bytes);
console.log('MB ' + (bytes / (1024 * 1024)).toFixed(2));
console.log('EMBEDDED_KEYS ' + EMB_KEYSLEN());
function EMB_KEYSLEN(){ return Object.keys(EMBEDDED).length; }
