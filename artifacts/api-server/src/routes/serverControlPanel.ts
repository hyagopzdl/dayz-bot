import { Router, type Request, type Response } from "express";
import postgres from "postgres";
import { getAdminServerAccess } from "../lib/adminUsers";
import { getManagedServerById, listManagedServers } from "../lib/serverRegistry";
import { refreshManagedServerRegistryFromDb } from "../lib/state";
import { getManagedServerRuntimeCoordinatorDiagnostics } from "../lib/serverRuntimeCoordinator";
import { getOrganizationIntegrationStatus } from "../lib/organizationIntegrations";

const router = Router();

function sql() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL nao configurado.");
  return postgres(process.env.DATABASE_URL, { ssl: "require", max: 1 });
}

async function requireServerManage(req: Request, res: Response, serverId: string) {
  const session = req.adminSession;
  if (!session?.adminUserId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return null; }
  const server = getManagedServerById(serverId);
  if (!server) { res.status(404).json({ error: "SERVER_NOT_FOUND" }); return null; }
  const access = await getAdminServerAccess(session.adminUserId, server.id);
  if (!access || access.organizationId !== server.organizationId) { res.status(403).json({ error: "ADMIN_SERVER_FORBIDDEN" }); return null; }
  return server;
}

function serviceStatus(server: ReturnType<typeof getManagedServerById>) {
  if (!server) return "unknown";
  const nitrado = Boolean(server.integrations.nitradoServiceId && server.runtime.nitradoBaseDir);
  const discord = Boolean(server.integrations.discordGuildId);
  const runtime = Boolean(server.enabled && server.runtimeEnabled);
  return {
    runtime: runtime ? "enabled" : "disabled",
    parser: runtime ? "enabled" : "disabled",
    discord: server.enabled && discord ? "configured" : "disabled",
    shop: runtime ? "enabled" : "disabled",
    mapEvents: runtime ? "enabled" : "disabled",
    nitrado: nitrado ? "configured" : "missing",
  };
}

router.get("/servers", (req, res) => {
  if (!req.adminSession?.adminUserId) { res.redirect("/admin-panel/login"); return; }
  res.type("html").send(buildPage());
});

router.get("/api/servers/control", async (req, res) => {
  if (!req.adminSession?.adminUserId) { res.status(401).json({ error: "AUTH_REQUIRED" }); return; }
  const anchorServer = req.adminSession.serverId ? getManagedServerById(req.adminSession.serverId) : undefined;
  if (!anchorServer) { res.status(403).json({ error: "ADMIN_SERVER_CONTEXT_REQUIRED" }); return; }
  const candidates = listManagedServers().filter((server) => server.organizationId === anchorServer.organizationId);
  const servers = (await Promise.all(candidates.map(async (server) => {
    const access = await getAdminServerAccess(req.adminSession!.adminUserId, server.id);
    return access && access.organizationId === server.organizationId ? server : null;
  }))).filter(Boolean) as NonNullable<ReturnType<typeof getManagedServerById>>[];
  const coordinator = getManagedServerRuntimeCoordinatorDiagnostics();
  const coordinatorByServer = new Map((coordinator.servers || []).map((item: any) => [item.serverId, item]));
  res.json({ servers: servers.map((server) => ({
    id: server.id, name: server.name, organizationId: server.organizationId, enabled: server.enabled,
    runtimeEnabled: server.runtimeEnabled, primary: server.primary, onboardingStatus: server.onboardingStatus,
    nitradoServiceId: server.integrations.nitradoServiceId || null, discordGuildId: server.integrations.discordGuildId || null,
    services: serviceStatus(server), runtimeHealth: (coordinatorByServer.get(server.id) as any)?.health || (server.runtimeEnabled ? "starting" : "stopped"),
    runtimeError: (coordinatorByServer.get(server.id) as any)?.lastError || null,
    nitradoIntegration: getOrganizationIntegrationStatus(server.organizationId),
  })) });
});

router.post("/api/servers/:serverId/master-switch", async (req, res) => {
  const serverId = String(req.params.serverId || "").trim();
  const server = await requireServerManage(req, res, serverId);
  if (!server) return;
  const enabled = req.body?.enabled === true;
  const db = sql();
  try {
    await db`
      UPDATE managed_servers
      SET enabled = ${enabled},
          runtime_config = jsonb_set(
            CASE
              WHEN runtime_config IS NULL THEN '{}'::jsonb
              WHEN jsonb_typeof(runtime_config) = 'object' THEN runtime_config
              ELSE jsonb_build_object('legacyRuntimeConfig', runtime_config)
            END,
            '{operations}',
            jsonb_build_object('paused', false, 'source', 'phase18-master-switch', 'masterDisabled', ${!enabled}),
            true
          ),
          updated_at = NOW()
      WHERE id = ${server.id}
    `;
    await refreshManagedServerRegistryFromDb();
    const updated = getManagedServerById(server.id);
    res.json({ server: updated, services: serviceStatus(updated) });
  } catch (error) {
    res.status(400).json({ error: "SERVER_MASTER_SWITCH_FAILED", message: error instanceof Error ? error.message : String(error) });
  } finally { await db.end({ timeout: 5 }).catch(() => undefined); }
});

function buildPage() {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ADM · Servidores</title>
<style>:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#08090c;color:#f5f5f7}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 20% 0%,#1b1d26 0,#0b0c10 36%,#08090c 72%);min-height:100vh}main{max-width:1180px;margin:0 auto;padding:48px 24px 72px}.eyebrow{font-size:12px;text-transform:uppercase;letter-spacing:.14em;color:#8f95a3;margin-bottom:10px}.head{display:flex;align-items:end;justify-content:space-between;gap:24px;margin-bottom:32px}.head h1{font-size:38px;letter-spacing:-.04em;margin:0 0 8px}.head p{margin:0;color:#9298a6}.refresh{border:1px solid #2d3039;background:#15171d;color:#fff;border-radius:12px;padding:10px 15px;cursor:pointer}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:18px}.card{border:1px solid #272a33;background:linear-gradient(145deg,rgba(28,30,38,.9),rgba(15,16,21,.94));border-radius:22px;padding:22px;box-shadow:0 18px 50px rgba(0,0,0,.22)}.top{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.name{font-size:21px;font-weight:700;letter-spacing:-.02em}.id{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:#777e8c;margin-top:5px}.badge{border-radius:999px;padding:6px 10px;font-size:11px;font-weight:700;background:#20232b;color:#aeb4c0}.badge.on{color:#b9f7d0;background:#123021}.badge.off{color:#ffb8b8;background:#351a1a}.meta{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:20px 0}.meta div{background:#111319;border:1px solid #20232b;border-radius:13px;padding:11px}.meta b{display:block;font-size:12px;color:#737a89;margin-bottom:4px}.meta span{font-size:13px}.services{border-top:1px solid #252832;padding-top:16px}.service{display:flex;justify-content:space-between;padding:9px 0;color:#b8bdc8;font-size:13px}.service strong{font-weight:600;color:#e7e8eb}.switchrow{display:flex;align-items:center;justify-content:space-between;margin-top:18px;padding-top:16px;border-top:1px solid #252832}.switchlabel b{display:block;font-size:14px}.switchlabel span{font-size:11px;color:#737a89}.switch{width:48px;height:28px;border-radius:99px;border:0;background:#393d47;padding:3px;cursor:pointer}.switch i{display:block;width:22px;height:22px;border-radius:50%;background:#fff;transition:.18s}.switch.on{background:#28a95a}.switch.on i{transform:translateX(20px)}.empty{border:1px dashed #30343e;border-radius:18px;padding:40px;text-align:center;color:#777e8b;grid-column:1/-1}@media(max-width:600px){main{padding:28px 16px}.head{align-items:flex-start;flex-direction:column}.head h1{font-size:30px}}</style></head>
<body><main><div class="head"><div><div class="eyebrow">Advanced DayZ Management</div><h1>Servidores</h1><p>Controle o estado operacional de cada servidor sem apagar configuração ou dados.</p></div><button class="refresh" onclick="load()">Atualizar</button></div><section id="grid" class="grid"><div class="empty">Carregando servidores…</div></section></main>
<script>
const esc=s=>String(s??'').replace(/[&<>\"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#039;'}[m]));
const labels={runtime:'Runtime / Scheduler',parser:'ADM Parser',discord:'Discord',shop:'Shop',mapEvents:'Map Events',nitrado:'Nitrado'};
function state(v){return v==='enabled'||v==='configured'?'OK':v==='disabled'?'Desligado':'Pendente'}
async function toggle(id,enabled){const r=await fetch('/admin-panel/api/servers/'+encodeURIComponent(id)+'/master-switch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled})});if(!r.ok){alert(await r.text());return}load()}
function card(s){const on=s.enabled;const serviceRows=Object.entries(s.services).map(([k,v])=>'<div class="service"><strong>'+labels[k]+'</strong><span>'+state(v)+'</span></div>').join('');return '<article class="card"><div class="top"><div><div class="name">'+esc(s.name)+'</div><div class="id">'+esc(s.id)+'</div></div><span class="badge '+(on?'on':'off')+'">'+(on?'ATIVO':'DESLIGADO')+'</span></div><div class="meta"><div><b>Nitrado</b><span>'+esc(s.nitradoServiceId||'Não configurado')+'</span></div><div><b>Runtime</b><span>'+esc(s.runtimeHealth)+'</span></div></div><div class="services">'+serviceRows+'</div><div class="switchrow"><div class="switchlabel"><b>Serviços do servidor</b><span>Desliga o circuito operacional deste servidor</span></div><button class="switch '+(on?'on':'')+'" aria-label="Alternar servidor" onclick="toggle('+esc(JSON.stringify(s.id))+', '+(!on)+')"><i></i></button></div></article>'}
async function load(){try{const r=await fetch('/admin-panel/api/servers/control');if(!r.ok)throw new Error(await r.text());const d=await r.json();document.getElementById('grid').innerHTML=d.servers.length?d.servers.map(card).join(''):'<div class="empty">Nenhum servidor disponível para esta conta.</div>'}catch(e){document.getElementById('grid').innerHTML='<div class="empty">Não foi possível carregar os servidores.<br>'+esc(e.message)+'</div>'}}
load();</script></body></html>`;
}
export default router;
