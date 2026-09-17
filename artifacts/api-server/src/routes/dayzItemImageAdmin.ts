import { Router, type Request, type Response } from "express";
import {
  getDayzItemImageOverrides,
  isSystemOwner,
  setDayzItemImageOverride,
} from "../lib/dayzItemOverridesService";
import { searchDzPageItems } from "../lib/dzpageService";

const router = Router();

function requireSystemOwner(req: Request, res: Response) {
  if (!req.adminSession) {
    res.status(401).json({ error: "Admin authentication required." });
    return false;
  }
  if (!isSystemOwner(req.adminSession.adminUserId)) {
    res.status(403).json({ error: "System owner access required." });
    return false;
  }
  return true;
}

router.get("/", (req, res) => {
  if (!req.adminSession) {
    res.redirect("/admin-panel/login");
    return;
  }
  if (!isSystemOwner(req.adminSession.adminUserId)) {
    res.status(403).send("System owner access required.");
    return;
  }

  res.type("html").send(`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ADM · Imagens globais</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#090a0c;color:#f5f7fa;font-family:Inter,ui-sans-serif,system-ui,sans-serif}.shell{width:min(1100px,calc(100% - 32px));margin:auto;padding:38px 0 70px}.top{display:flex;justify-content:space-between;align-items:center;gap:20px;margin-bottom:22px}.eyebrow{font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:#8f98a8;font-weight:800}.title{margin:5px 0 0;font-size:28px;letter-spacing:-.03em}.card{background:#111318;border:1px solid #292d36;border-radius:18px;padding:18px;box-shadow:0 12px 45px rgba(0,0,0,.18)}.search{display:flex;gap:10px}.search input{flex:1;min-width:0;background:#0b0d11;border:1px solid #303540;border-radius:11px;padding:12px 13px;color:#fff;outline:none}.button{border:1px solid #343943;background:#20242b;color:#fff;border-radius:11px;padding:0 15px;font-weight:800;cursor:pointer;min-height:42px}.button.primary{background:#fff;color:#0b0d11;border-color:#fff}.button.danger{color:#ffb1b7}.results{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;margin-top:16px}.item{display:flex;gap:12px;align-items:center;padding:12px;border:1px solid #292d36;border-radius:14px;background:#0d0f13}.thumb{width:58px;height:58px;border-radius:10px;object-fit:contain;background:#171a20;flex:none}.meta{min-width:0;flex:1}.name{font-weight:850;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.class{font-size:11px;color:#858e9d;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.actions{display:flex;gap:7px;margin-top:9px}.small{min-height:32px;padding:0 10px;font-size:11px}.empty{padding:28px;text-align:center;color:#858e9d}.override{margin-top:25px}.override h2{font-size:15px;margin:0 0 12px}.row{display:flex;gap:10px;align-items:center;padding:10px 0;border-bottom:1px solid #242831}.row img{width:44px;height:44px;object-fit:contain;border-radius:8px;background:#171a20}.row .meta{min-width:0}.status{margin-top:10px;font-size:12px;color:#8f98a8}.back{color:#aeb6c4;text-decoration:none;font-size:12px;font-weight:800}.error{color:#ffadb4}
</style>
</head>
<body>
<main class="shell">
<div class="top"><div><div class="eyebrow">System Owner</div><h1 class="title">Imagens globais do catálogo</h1></div><a class="back" href="/admin-panel">← Voltar ao painel</a></div>
<section class="card">
<div class="search"><input id="q" placeholder="Pesquisar item por nome ou ClassName..." autocomplete="off"><button class="button primary" id="search">Pesquisar</button></div>
<div class="status" id="status">As imagens definidas aqui valem para todos os servidores.</div>
<div class="results" id="results"><div class="empty">Pesquise um item para começar.</div></div>
<div class="override"><h2>Overrides ativos</h2><div id="overrides"><div class="empty">Carregando...</div></div></div>
</section>
</main>
<script>
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(url,options){const r=await fetch(url,{credentials:'same-origin',...options});let d=null;try{d=await r.json()}catch{}if(!r.ok)throw new Error(d?.error||('HTTP '+r.status));return d}
function itemCard(i){const src=i.iconUrl||i.iconThumbUrl||'';return '<article class="item"><img class="thumb" src="'+esc(src)+'" onerror="this.style.visibility=\'hidden\'"><div class="meta"><div class="name">'+esc(i.name)+'</div><div class="class">'+esc(i.className)+'</div><div class="actions"><button class="button small primary" data-class="'+esc(i.className)+'" data-name="'+esc(i.name)+'" data-image="'+esc(src)+'">Definir imagem</button></div></div></article>'}
async function search(){const q=$('q').value.trim();$('status').textContent='Pesquisando na DZPage...';try{const d=await api('/admin-panel/system/dayz-images/search?q='+encodeURIComponent(q));$('results').innerHTML=d.items.length?d.items.map(itemCard).join(''):'<div class="empty">Nenhum item encontrado.</div>';document.querySelectorAll('[data-class]').forEach(b=>b.onclick=()=>setOverride(b.dataset.class,b.dataset.name,b.dataset.image));$('status').textContent='Fonte: DZPage. Overrides globais são aplicados sobre a imagem original.'}catch(e){$('status').innerHTML='<span class="error">'+esc(e.message)+'</span>'}}
async function loadOverrides(){try{const d=await api('/admin-panel/system/dayz-images/overrides');$('overrides').innerHTML=d.overrides.length?d.overrides.map(o=>'<div class="row"><img src="'+esc(o.imageUrl)+'" onerror="this.style.visibility=\'hidden\'"><div class="meta"><div class="name">'+esc(o.className)+'</div><div class="class">'+esc(o.imageUrl)+'</div></div><button class="button small danger" data-remove="'+esc(o.className)+'">Remover</button></div>').join(''):'<div class="empty">Nenhum override definido.</div>';document.querySelectorAll('[data-remove]').forEach(b=>b.onclick=()=>removeOverride(b.dataset.remove))}catch(e){$('overrides').innerHTML='<div class="empty error">'+esc(e.message)+'</div>'}}
async function setOverride(className,name,current){const image=prompt('URL da imagem para '+name+' ('+className+'):',current||'');if(image===null)return;if(!/^https?:\/\//i.test(image.trim()))return alert('Informe uma URL http(s) válida.');try{await api('/admin-panel/system/dayz-images/overrides/'+encodeURIComponent(className),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({imageUrl:image.trim()})});await loadOverrides();alert('Imagem global salva.')}catch(e){alert(e.message)}}
async function removeOverride(className){if(!confirm('Remover o override global de '+className+'?'))return;try{await api('/admin-panel/system/dayz-images/overrides/'+encodeURIComponent(className),{method:'DELETE'});await loadOverrides()}catch(e){alert(e.message)}}
$('search').onclick=search;
$('q').addEventListener('keydown',e=>{if(e.key==='Enter')search()});
loadOverrides();
</script>
</body>
</html>`);
});

router.get("/search", async (req, res) => {
  try {
    if (!requireSystemOwner(req, res)) {
      return;
    }
    const query = String(req.query.q || "").trim();
    const result = await searchDzPageItems({ query, page: 1, limit: 48, language: "pt" });
    res.json(result);
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.get("/overrides", async (req, res) => {
  try {
    if (!requireSystemOwner(req, res)) {
      return;
    }
    const values = await getDayzItemImageOverrides();
    res.json({ overrides: [...values.entries()].map(([className, imageUrl]) => ({ className, imageUrl })) });
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.put("/overrides/:className", async (req, res) => {
  try {
    if (!requireSystemOwner(req, res)) {
      return;
    }
    const className = decodeURIComponent(String(req.params.className || "")).trim();
    const imageUrl = typeof req.body?.imageUrl === "string" ? req.body.imageUrl.trim() : "";
    if (!className) {
      res.status(400).json({ error: "className is required." });
      return;
    }
    if (imageUrl.length > 2048 || !/^https?:\/\//i.test(imageUrl)) {
      res.status(400).json({ error: "imageUrl must be a valid http(s) URL up to 2048 characters." });
      return;
    }
    await setDayzItemImageOverride(className, imageUrl);
    res.json({ className, imageUrl });
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.delete("/overrides/:className", async (req, res) => {
  try {
    if (!requireSystemOwner(req, res)) {
      return;
    }
    const className = decodeURIComponent(String(req.params.className || "")).trim();
    if (!className) {
      res.status(400).json({ error: "className is required." });
      return;
    }
    await setDayzItemImageOverride(className, null);
    res.status(204).end();
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

export default router;
