from pathlib import Path
import re

p = Path("artifacts/api-server/src/lib/nitradoDownloader.ts")
t = p.read_text()
t = t.replace("getServerRuntimeContext(serverId).nitrado.baseDir || LEGACY_BASE_DIR", "getServerRuntimeContext(serverId).nitrado.baseDir || \"\"")
t = t.replace("String(getServerRuntimeContext(serverId).nitrado.baseDir || LEGACY_BASE_DIR)", "String(getServerRuntimeContext(serverId).nitrado.baseDir || \"\")")
p.write_text(t)

p = Path("artifacts/api-server/src/lib/serverNitrado.ts")
t = p.read_text()
t = re.sub(r'apiTokenSource:\s*"server-secret"\s*\|\s*"organization-secret"\s*\|\s*"environment-fallback";', 'apiTokenSource: "server-secret" | "organization-secret" | "environment-fallback" | "missing";', t)
t = re.sub(r'apiTokenSource:\s*"organization-secret"\s*\|\s*"environment-fallback"\s*\|\s*"server-secret";', 'apiTokenSource: "server-secret" | "organization-secret" | "environment-fallback" | "missing";', t)
p.write_text(t)
print("Patch 2 typecheck fixes complete")
