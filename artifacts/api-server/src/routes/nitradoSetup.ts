import postgres from "postgres";
import { Router, type Request, type Response } from "express";
import { readPortalSession } from "../auth/session";
import {
  canOrganizationRole,
  getManagedOrganizationById,
  listUserOrganizationMemberships,
} from "../lib/organizationRegistry";
import {
  encryptOrganizationSecret,
  getOrganizationIntegrationRecord,
  setPersistedOrganizationIntegrations,
} from "../lib/organizationIntegrations";
import {
  createManagedServerDraft,
  getStatePersistenceMetrics,
} from "../lib/state";
import { getManagedServerById, listManagedServers } from "../lib/serverRegistry";

const router = Router();
const NITRADO_API = "https://api.nitrado.net";

type NitradoService = {
  id: number | string;
  status?: string;
  type?: string;
  type_human?: string;
  username?: string;
  details?: {
    name?: string;
    game?: string;
    slots?: number;
    address?: string;
    folder_short?: string;
  };
};

function json(res: Response, status: number, payload: unknown) {
  return res.status(status).json(payload);
}

function session(req: Request) {
  const value = req.portalSession || readPortalSession(req);
  if (!value) throw new Error("Sessão do portal não encontrada.");
  return value;
}

function organizationFor(req: Request, requested?: unknown) {
  const current = session(req);
  const memberships = listUserOrganizationMemberships(current.discordId).filter((membership) =>
    canOrganizationRole(membership.role, "manage"),
  );
  if (!memberships.length) throw new Error("Sua conta não possui uma organização com permissão de gerenciamento.");

  const requestedId = String(requested || "").trim();
  const membership = requestedId
    ? memberships.find((candidate) => candidate.organizationId === requestedId)
    : memberships[0];
  if (!membership) throw new Error("Organização inválida ou sem permissão.");

  const organization = getManagedOrganizationById(membership.organizationId);
  if (!organization?.active) throw new Error("A organização selecionada está inativa.");
  return { organization, membership };
}

async function nitradoRequest<T>(token: string, pathname: string): Promise<T> {
  const response = await fetch(`${NITRADO_API}${pathname}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  const text = await response.text();
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
  if (!response.ok) {
    const message = String(body?.message || body?.error || body?.status || "Nitrado recusou a requisição.");
    throw new Error(`Nitrado HTTP ${response.status}: ${message}`);
  }
  return body as T;
}

function sanitizeService(service: NitradoService) {
  const game = String(service.details?.game || service.type_human || service.type || "").trim();
  return {
    id: String(service.id),
    name: String(service.details?.name || service.username || `Nitrado ${service.id}`).trim(),
    game,
    status: String(service.status || "unknown"),
    slots: Number(service.details?.slots || 0) || null,
    address: String(service.details?.address || "").trim() || null,
    username: String(service.username || "").trim() || null,
    dayz: /dayz/i.test(game),
  };
}

function inferBaseDir(gameserver: any) {
  const candidates = [
    gameserver?.game_specific?.path,
    gameserver?.game_specific?.config_path,
    gameserver?.path,
  ];
  const raw = candidates.find((value) => typeof value === "string" && value.trim());
  if (!raw) return "";
  const normalized = String(raw).trim().replace(/\\/g, "/").replace(/\/+$/g, "");
  if (/\/config$/i.test(normalized)) return normalized;
  if (/\/dayzps$/i.test(normalized)) return `${normalized}/config`;
  return normalized;
}

async function listServices(token: string) {
  const body = await nitradoRequest<{ data?: { services?: NitradoService[] } }>(token, "/services");
  return Array.isArray(body?.data?.services) ? body.data.services.map(sanitizeService) : [];
}

async function saveOrganizationToken(organizationId: string, token: string) {
  const encrypted = encryptOrganizationSecret(token);
  const db = process.env.DATABASE_URL ? postgres(process.env.DATABASE_URL, { ssl: "require", max: 1 }) : null;
  if (!db) throw new Error("DATABASE_URL não está configurado.");
  try {
    await db`
      CREATE TABLE IF NOT EXISTS organization_integrations (
        organization_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        encrypted_secret TEXT NOT NULL,
        iv TEXT NOT NULL,
        auth_tag TEXT NOT NULL,
        key_version INTEGER NOT NULL DEFAULT 1,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (organization_id, provider)
      )
    `;
    await db`
      INSERT INTO organization_integrations (
        organization_id, provider, encrypted_secret, iv, auth_tag, key_version, metadata, active, created_at, updated_at
      ) VALUES (
        ${organizationId}, 'nitrado', ${encrypted.encryptedSecret}, ${encrypted.iv}, ${encrypted.authTag}, ${encrypted.keyVersion}, '{}'::jsonb, TRUE, NOW(), NOW()
      )
      ON CONFLICT (organization_id, provider) DO UPDATE SET
        encrypted_secret = EXCLUDED.encrypted_secret,
        iv = EXCLUDED.iv,
        auth_tag = EXCLUDED.auth_tag,
        key_version = EXCLUDED.key_version,
        active = TRUE,
        updated_at = NOW()
    `;
    setPersistedOrganizationIntegrations([{
      organizationId,
      provider: "nitrado",
      encryptedSecret: encrypted.encryptedSecret,
      iv: encrypted.iv,
      authTag: encrypted.authTag,
      keyVersion: encrypted.keyVersion,
      metadata: {},
      active: true,
      updatedAt: new Date().toISOString(),
    }]);
  } finally {
    await db.end({ timeout: 5 }).catch(() => undefined);
  }
}

function storedTokenStatus(organizationId: string) {
  const record = getOrganizationIntegrationRecord(organizationId, "nitrado");
  return { configured: Boolean(record?.active), updatedAt: record?.updatedAt || null };
}

router.get("/api/setup/nitrado/state", async (req, res) => {
  try {
    const { organization, membership } = organizationFor(req, req.query.organizationId);
    return json(res, 200, {
      organization: { id: organization.id, name: organization.name },
      role: membership.role,
      token: storedTokenStatus(organization.id),
      servers: listManagedServers().filter((server) => server.organizationId === organization.id).map((server) => ({
        id: server.id,
        name: server.name,
        serviceId: server.integrations.nitradoServiceId || null,
        status: server.onboardingStatus,
      })),
      persistence: getStatePersistenceMetrics(),
    });
  } catch (error) {
    return json(res, 403, { message: error instanceof Error ? error.message : String(error) });
  }
});

router.post("/api/setup/nitrado/connect", async (req, res) => {
  try {
    const { organization } = organizationFor(req, req.body?.organizationId);
    const token = String(req.body?.token || "").trim();
    if (!token) return json(res, 400, { message: "Cole o Long-life token da Nitrado." });
    if (token.length > 4096) return json(res, 400, { message: "Token Nitrado inválido." });

    const services = await listServices(token);
    await saveOrganizationToken(organization.id, token);

    return json(res, 200, {
      connected: true,
      organization: { id: organization.id, name: organization.name },
      services,
      dayzServices: services.filter((service) => service.dayz),
      message: services.length
        ? `${services.length} serviço(s) encontrado(s) na sua conta Nitrado.`
        : "Token válido, mas nenhum serviço foi retornado pela Nitrado.",
    });
  } catch (error) {
    return json(res, 400, { message: error instanceof Error ? error.message : String(error) });
  }
});

router.get("/api/setup/nitrado/services", async (req, res) => {
  try {
    const { organization } = organizationFor(req, req.query.organizationId);
    const record = getOrganizationIntegrationRecord(organization.id, "nitrado");
    if (!record?.active) return json(res, 409, { message: "Conecte sua conta Nitrado primeiro." });
    const { decryptEncryptedSecret } = await import("../lib/organizationIntegrations");
    const token = decryptEncryptedSecret(record);
    const services = await listServices(token);
    return json(res, 200, { services, dayzServices: services.filter((service) => service.dayz) });
  } catch (error) {
    return json(res, 400, { message: error instanceof Error ? error.message : String(error) });
  }
});

router.post("/api/setup/nitrado/import", async (req, res) => {
  try {
    const { organization } = organizationFor(req, req.body?.organizationId);
    const serviceId = String(req.body?.serviceId || "").trim();
    if (!/^\d+$/.test(serviceId)) return json(res, 400, { message: "Selecione um serviço Nitrado válido." });

    const record = getOrganizationIntegrationRecord(organization.id, "nitrado");
    if (!record?.active) return json(res, 409, { message: "Conecte sua conta Nitrado primeiro." });
    const { decryptEncryptedSecret } = await import("../lib/organizationIntegrations");
    const token = decryptEncryptedSecret(record);
    const services = await listServices(token);
    const service = services.find((candidate) => candidate.id === serviceId);
    if (!service) return json(res, 404, { message: "Esse serviço não pertence à conta Nitrado conectada." });
    if (!service.dayz) return json(res, 400, { message: "Este serviço não parece ser um servidor DayZ." });

    const existing = listManagedServers().find((server) => server.organizationId === organization.id && server.integrations.nitradoServiceId === serviceId);
    if (existing) {
      return json(res, 200, { created: false, server: { id: existing.id, name: existing.name }, message: "Esse servidor já está conectado ao workspace." });
    }

    const detail = await nitradoRequest<{ data?: { gameserver?: any } }>(token, `/services/${encodeURIComponent(serviceId)}/gameservers`);
    const gameserver = detail?.data?.gameserver || {};
    const baseDir = inferBaseDir(gameserver);
    const serverName = String(gameserver?.query?.server_name || service.name || `DayZ ${serviceId}`).trim().slice(0, 100);
    const descriptor = await createManagedServerDraft({
      organizationId: organization.id,
      name: serverName,
      id: serverName,
      nitradoServiceId: serviceId,
      nitradoBaseDir: baseDir || undefined,
    });

    return json(res, 201, {
      created: true,
      server: {
        id: descriptor.id,
        name: descriptor.name,
        serviceId,
        baseDir: baseDir || null,
        status: descriptor.onboardingStatus,
      },
      message: baseDir
        ? "Servidor importado. O Service ID e o caminho Nitrado foram preenchidos automaticamente."
        : "Servidor importado. O Service ID foi preenchido; o caminho base precisa ser confirmado no setup.",
    });
  } catch (error) {
    return json(res, 400, { message: error instanceof Error ? error.message : String(error) });
  }
});

router.post("/api/setup/nitrado/disconnect", async (req, res) => {
  try {
    const { organization } = organizationFor(req, req.body?.organizationId);
    const db = process.env.DATABASE_URL ? postgres(process.env.DATABASE_URL, { ssl: "require", max: 1 }) : null;
    if (!db) throw new Error("DATABASE_URL não está configurado.");
    try {
      await db`UPDATE organization_integrations SET active = FALSE, updated_at = NOW() WHERE organization_id = ${organization.id} AND provider = 'nitrado'`;
      setPersistedOrganizationIntegrations([]);
    } finally {
      await db.end({ timeout: 5 }).catch(() => undefined);
    }
    return json(res, 200, { disconnected: true });
  } catch (error) {
    return json(res, 400, { message: error instanceof Error ? error.message : String(error) });
  }
});

function escapeHtml(value: unknown) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

export function renderNitradoSetup() {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ADM · Conectar Nitrado</title><style>
:root{color-scheme:dark;--bg:#172235;--card:#202d42;--card2:#2c3a50;--border:#40506a;--text:#f5f7fb;--muted:#9faabd;--cyan:#16d8eb;--green:#51df9b;--orange:#ff9418;--red:#ff6470}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 15% -10%,#263b58 0,#172235 45%,#101a29 100%);color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif}.shell{width:min(1040px,calc(100% - 32px));margin:0 auto;padding:42px 0 72px}.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:28px}.brand{font-size:18px;font-weight:900;letter-spacing:-.02em}.user{font-size:12px;color:var(--muted)}.hero{padding:28px 30px;border:1px solid var(--border);border-radius:14px;background:linear-gradient(145deg,#2a3950,#202d42);box-shadow:0 22px 70px #0003}.eyebrow{color:var(--cyan);font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.12em}.hero h1{font-size:36px;letter-spacing:-.045em;margin:8px 0 9px}.hero p{margin:0;color:var(--muted);max-width:720px;line-height:1.6}.steps{display:grid;gap:16px;margin-top:18px}.card{padding:24px;border:1px solid var(--border);border-radius:12px;background:rgba(32,45,66,.96)}.stepHead{display:flex;gap:14px;align-items:flex-start}.num{width:34px;height:34px;border-radius:50%;display:grid;place-items:center;background:var(--cyan);color:#102032;font-weight:950;flex:0 0 auto}.num.orange{background:var(--orange)}.num.green{background:var(--green)}h2{font-size:18px;margin:1px 0 5px}.muted{color:var(--muted);font-size:13px;line-height:1.5}.field{display:grid;gap:8px;margin-top:18px}.field label{font-size:12px;font-weight:800}.field input,.field select{width:100%;height:48px;border:1px solid #4a5970;border-radius:9px;background:#303e53;color:var(--text);padding:0 14px;font-size:14px;outline:0}.field input:focus,.field select:focus{border-color:var(--cyan);box-shadow:0 0 0 3px #16d8eb1c}.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}button,a.btn{min-height:42px;padding:0 16px;border:1px solid #4a5970;border-radius:9px;background:#303e53;color:var(--text);font-weight:850;font-size:12px;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;cursor:pointer}button.primary,a.primary{background:var(--cyan);color:#102032;border-color:var(--cyan)}button:disabled{opacity:.45;cursor:not-allowed}.status{margin-top:14px;padding:13px 14px;border-radius:9px;background:#1a2638;color:var(--muted);font-size:12px;line-height:1.5}.status.ok{color:var(--green);border:1px solid #51df9b38}.status.error{color:#ff9da6;border:1px solid #ff647038}.tokenRow{display:flex;gap:8px}.tokenRow input{flex:1}.services{display:grid;gap:8px;margin-top:16px}.service{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:14px;border:1px solid var(--border);border-radius:10px;background:#1b2739}.service.dayz{border-color:#16d8eb44}.service strong{font-size:13px}.service small{display:block;color:var(--muted);margin-top:4px}.pill{font-size:10px;font-weight:900;padding:5px 8px;border-radius:999px;background:#35445a;color:#cbd4e2}.pill.dayz{background:#16d8eb18;color:var(--cyan)}.hidden{display:none!important}.success{background:#51df9b0c;border-color:#51df9b44}.hint{font-size:11px;color:var(--muted);margin-top:10px}.danger{color:#ff8e98}.divider{height:1px;background:var(--border);margin:20px 0}@media(max-width:680px){.shell{padding-top:22px}.top{align-items:flex-start;gap:8px;flex-direction:column}.hero h1{font-size:29px}.tokenRow{flex-direction:column}}
</style></head><body><main class="shell"><div class="top"><div class="brand">Advanced DayZ Management</div><div class="user" id="user">Configuração Nitrado</div></div><section class="hero"><div class="eyebrow">Primeiro acesso · Nitrado</div><h1>Conecte sua conta Nitrado.</h1><p>Você não precisa descobrir Service ID, username ou servidor manualmente. Informe apenas seu <strong>Long-life token</strong> e o ADM consulta os serviços disponíveis na sua conta. A credencial fica armazenada criptografada e nunca é enviada de volta para o navegador.</p></section><div class="steps"><section class="card"><div class="stepHead"><div class="num">1</div><div><h2>Conecte o Nitrado</h2><div class="muted">Crie um Long-life token no Developer Portal da Nitrado com a permissão <strong>service</strong>.</div></div></div><div id="orgWrap" class="field"><label>Workspace</label><select id="org"></select></div><div class="field"><label>Long-life token</label><div class="tokenRow"><input id="token" type="password" autocomplete="new-password" placeholder="Cole o token aqui"><button class="primary" id="connect">Validar e conectar</button></div></div><div id="tokenStatus" class="status">Ainda não conectado.</div><div class="actions"><button id="disconnect" class="danger">Remover credencial</button></div></section><section id="servicesCard" class="card hidden"><div class="stepHead"><div class="num orange">2</div><div><h2>Seus servidores Nitrado</h2><div class="muted">Os serviços abaixo vieram diretamente da conta conectada. Servidores DayZ ficam destacados.</div></div></div><div id="services" class="services"></div><div id="serviceStatus" class="status">Selecione um servidor DayZ para continuar.</div></section><section id="importCard" class="card hidden"><div class="stepHead"><div class="num green">3</div><div><h2>Adicionar servidor ao ADM</h2><div class="muted">O ADM usa os dados retornados pela Nitrado para preencher o cadastro inicial. Você poderá revisar e executar o preflight antes de ativar o runtime.</div></div></div><div class="field"><label>Servidor selecionado</label><input id="selectedService" disabled></div><div class="actions"><button class="primary" id="import">Importar servidor e continuar</button><a class="btn" href="/admin-panel/servers">Gerenciar servidores</a></div><div id="importStatus" class="status">Nenhum servidor selecionado.</div></section></div></main><script>
const $=id=>document.getElementById(id);let selected=null;const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
async function api(path,init={}){const r=await fetch(path,{credentials:'same-origin',headers:{Accept:'application/json',...(init.body?{'Content-Type':'application/json'}:{})},...init});const t=await r.text();let d={};try{d=t?JSON.parse(t):{}}catch{d={message:t}}if(!r.ok)throw new Error(d.message||'Não foi possível concluir a operação.');return d}
function status(el,msg,type=''){el.textContent=msg;el.className='status '+type}
function renderServices(list){$('services').innerHTML=list.length?list.map(s=>'<div class="service '+(s.dayz?'dayz':'')+'"><div><strong>'+esc(s.name)+'</strong><small>'+esc(s.game||'Serviço Nitrado')+' · '+esc(s.status)+' · '+esc(s.id)+(s.slots?' · '+s.slots+' slots':'')+'</small></div><div style="display:flex;gap:8px;align-items:center"><span class="pill '+(s.dayz?'dayz':'')+'">'+(s.dayz?'DAYZ':'OUTRO')+'</span>'+(s.dayz?'<button type="button" data-service="'+esc(s.id)+'">Selecionar</button>':'')+'</div></div>').join(''):'<div class="status">Nenhum serviço foi retornado.</div>';document.querySelectorAll('[data-service]').forEach(b=>b.onclick=()=>selectService(String(b.dataset.service),list));}
function selectService(id,list){selected=list.find(s=>String(s.id)===id);if(!selected)return;$('importCard').classList.remove('hidden');$('selectedService').value=selected.name+' · '+selected.id;status($('serviceStatus'),'Servidor DayZ selecionado. O próximo passo é importar o cadastro.','ok');$('import').disabled=false;window.scrollTo({top:$('importCard').offsetTop-20,behavior:'smooth'});}
async function load(){try{const d=await api('/admin-panel/api/setup/nitrado/state');$('user').textContent=d.organization.name+' · '+d.role;$('org').innerHTML='<option value="'+esc(d.organization.id)+'">'+esc(d.organization.name)+'</option>';if(d.token.configured){status($('tokenStatus'),'Nitrado já conectado. Carregando os serviços da conta…','ok');await loadServices(d.organization.id)}else status($('tokenStatus'),'Cole o Long-life token para validar a conta e descobrir os servidores.');}catch(e){status($('tokenStatus'),e.message,'error');}}
async function loadServices(org){try{const d=await api('/admin-panel/api/setup/nitrado/services?organizationId='+encodeURIComponent(org));$('servicesCard').classList.remove('hidden');renderServices(d.services||[]);status($('serviceStatus'),(d.dayzServices||[]).length+' servidor(es) DayZ encontrado(s).','ok')}catch(e){status($('tokenStatus'),e.message,'error')}}
$('connect').onclick=async()=>{const token=$('token').value.trim();if(!token){status($('tokenStatus'),'Cole o Long-life token antes de continuar.','error');return}const b=$('connect');b.disabled=true;b.textContent='Validando…';try{const d=await api('/admin-panel/api/setup/nitrado/connect',{method:'POST',body:JSON.stringify({organizationId:$('org').value,token})});$('token').value='';status($('tokenStatus'),d.message||'Nitrado conectado.','ok');$('servicesCard').classList.remove('hidden');renderServices(d.services||[]);status($('serviceStatus'),(d.dayzServices||[]).length+' servidor(es) DayZ encontrado(s).','ok')}catch(e){status($('tokenStatus'),e.message,'error')}finally{b.disabled=false;b.textContent='Validar e conectar'}};
$('import').onclick=async()=>{if(!selected)return;const b=$('import');b.disabled=true;b.textContent='Importando…';try{const d=await api('/admin-panel/api/setup/nitrado/import',{method:'POST',body:JSON.stringify({organizationId:$('org').value,serviceId:selected.id})});status($('importStatus'),d.message||'Servidor importado.','ok');b.textContent='Servidor importado';setTimeout(()=>location.href='/admin-panel/onboarding?serverId='+encodeURIComponent(d.server?.id||''),900)}catch(e){status($('importStatus'),e.message,'error');b.disabled=false;b.textContent='Importar servidor e continuar'}};
$('disconnect').onclick=async()=>{if(!confirm('Remover a credencial Nitrado deste workspace? Os servidores cadastrados não serão apagados.'))return;try{await api('/admin-panel/api/setup/nitrado/disconnect',{method:'POST',body:JSON.stringify({organizationId:$('org').value})});$('servicesCard').classList.add('hidden');$('importCard').classList.add('hidden');status($('tokenStatus'),'Credencial removida. Os servidores e seus dados foram preservados.')}catch(e){status($('tokenStatus'),e.message,'error')}};
load();
</script></body></html>`;
}

router.get("/nitrado-setup", (req, res) => {
  if (!req.portalSession && !readPortalSession(req)) return res.redirect("/api/auth/discord?returnTo=/admin-panel/nitrado-setup");
  return res.type("html").send(renderNitradoSetup());
});

export default router;
