# Admin Panel Preview

Este preview permite ajustar o visual do painel admin sem rodar Discord, Neon, Nitrado ou o servidor real.

## Como abrir no Replit

Na pasta `artifacts/api-server`, rode:

```bash
node tools/serve-admin-panel-preview.mjs
```

Abra a URL exibida pelo Replit. O arquivo servido é:

```text
tools/admin-panel-preview.html
```

## Como editar

Edite o CSS entre os marcadores:

```css
/* ADMIN_PANEL_SHARED_STYLE_START */
...
/* ADMIN_PANEL_SHARED_STYLE_END */
```

O bloco `PREVIEW_ONLY_STYLE_START/END` existe só para o painel flutuante do preview e não deve ir para produção.

## Como aplicar no painel real

Depois de gostar do visual, rode:

```bash
node tools/sync-admin-panel-style-from-preview.mjs
pnpm --filter @workspace/api-server typecheck
```

O script copia o CSS compartilhado do preview para:

```text
src/routes/adminPanel.ts
```

Depois faça o commit normalmente.
