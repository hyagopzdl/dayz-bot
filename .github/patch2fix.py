from pathlib import Path

p = Path("artifacts/api-server/src/lib/nitradoDownloader.ts")
t = p.read_text()
t = t.replace("getServerRuntimeContext(serverId).nitrado.baseDir || LEGACY_BASE_DIR", "getServerRuntimeContext(serverId).nitrado.baseDir")
t = t.replace("String(getServerRuntimeContext(serverId).nitrado.baseDir || LEGACY_BASE_DIR)", "String(getServerRuntimeContext(serverId).nitrado.baseDir)")
p.write_text(t)

p = Path("artifacts/api-server/src/lib/serverNitrado.ts")
t = p.read_text().replace('apiTokenSource: "organization-secret" | "environment-fallback" | "server-secret";', 'apiTokenSource: "organization-secret" | "environment-fallback" | "server-secret" | "missing";')
p.write_text(t)

print("Patch 2 typecheck fixes complete")
