# DayZ Fandom Image Miner para Replit

Este pacote lê `dayz-items.json` e gera um novo JSON com `urlImg` em todos os itens.

- Quando encontra imagem no Fandom: `urlImg` recebe a URL `static.wikia.nocookie.net`.
- Quando não encontra imagem: `urlImg` recebe `/artifacts/api-server/assets/ui/img-placeholder.png`.
- O JSON final não inclui `wikiUrl`.

## Como rodar no Replit

1. Crie um Repl de Node.js ou use seu projeto atual.
2. Envie estes arquivos para o Replit:
   - `mine-dayz-images.mjs`
   - `package.json`
   - `dayz-items.json`
   3. No Shell, rode:

```bash
npm start
```

Para testar primeiro com 10 itens:

```bash
npm run test:10
```

## Arquivo gerado

O principal arquivo será:

```bash
dayz-items-with-url-img.json
```

Exemplo de saída:

```json
{
  "className": "Barrel_Red",
  "popularName": "Barrel Red",
  "urlImg": "https://static.wikia.nocookie.net/dayz_gamepedia/images/b/bc/OilBarrel_Red.png/revision/latest?cb=20150718114354"
}
```

Se não encontrar imagem:

```json
{
  "className": "AlgumItem",
  "popularName": "Algum Item",
  "urlImg": "/artifacts/api-server/assets/ui/img-placeholder.png"
}
```

Também é gerado um CSV de auditoria:

```bash
dayz-items-image-audit.csv
```

Esse CSV serve para você ver quais itens bateram com imagem real e quais caíram no placeholder.

## Opções úteis

Rodar com outro input/output:

```bash
node mine-dayz-images.mjs --input meus-itens.json --output meus-itens-com-img.json
```

Mudar placeholder, se algum dia precisar:

```bash
node mine-dayz-images.mjs --placeholder https://seusite.com/placeholder-image.svg
```

Aumentar/reduzir delay entre chamadas:

```bash
node mine-dayz-images.mjs --delay-ms 500
```


## Placeholder padrão desta versão

Esta versão já está configurada para usar:

```txt
/artifacts/api-server/assets/ui/img-placeholder.png
```

O arquivo `placeholder-image.svg` antigo não é mais necessário para o funcionamento do minerador.
