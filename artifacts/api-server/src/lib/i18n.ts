export type Locale = "en" | "pt";

export const DEFAULT_LOCALE: Locale = "en";

const messages = {
  en: {
    common: {
      confirm: "Confirm",
      cancel: "Cancel",
      languageEnglish: "English",
      languagePortuguese: "Português",
    },
    link: {
      commandDescription: "Link your Discord account to your DayZ gamertag.",
      gamertagOptionDescription: "Your DayZ / console gamertag.",
      unlinkDescription: "Unlink your Discord account from your DayZ gamertag.",
      linkedTitle: "Account linked",
      linkedDescription: "Your gamertag has been linked successfully.",
      chooseLanguage: "Choose your bot language before confirming.",
      languageLabel: "Language",
      gamertagLabel: "Gamertag",
      confirmTitle: "Account setup completed",
      confirmDescription: "Your Discord account is now linked to your DayZ gamertag.",
      commandsTitle: "Available commands",
      shopCommand: "/shop — Open the item shop",
      bankCommand: "/bank — View your coin balance (coming soon)",
      selectPlaceholder: "Select your language",
      notYourSetup: "This setup belongs to another user.",
      noLinkFound: "You do not have a linked gamertag yet. Use /link first.",
      alreadyUsedGamertag: "This gamertag is already linked to another Discord account.",
      invalidGamertag: "Invalid gamertag. Use 2 to 32 visible characters.",
      unlinked: "Your gamertag has been unlinked.",
    },
  },
  pt: {
    common: {
      confirm: "Confirmar",
      cancel: "Cancelar",
      languageEnglish: "English",
      languagePortuguese: "Português",
    },
    link: {
      commandDescription: "Vincule sua conta do Discord à sua gamertag do DayZ.",
      gamertagOptionDescription: "Sua gamertag do DayZ / console.",
      unlinkDescription: "Remova o vínculo entre seu Discord e sua gamertag do DayZ.",
      linkedTitle: "Conta vinculada",
      linkedDescription: "Sua gamertag foi vinculada com sucesso.",
      chooseLanguage: "Escolha o idioma do bot antes de confirmar.",
      languageLabel: "Idioma",
      gamertagLabel: "Gamertag",
      confirmTitle: "Configuração concluída",
      confirmDescription: "Sua conta do Discord agora está vinculada à sua gamertag do DayZ.",
      commandsTitle: "Comandos disponíveis",
      shopCommand: "/shop — Abrir a loja de itens",
      bankCommand: "/bank — Ver seu saldo de moedas (em breve)",
      selectPlaceholder: "Selecione seu idioma",
      notYourSetup: "Esta configuração pertence a outro usuário.",
      noLinkFound: "Você ainda não vinculou uma gamertag. Use /link primeiro.",
      alreadyUsedGamertag: "Esta gamertag já está vinculada a outra conta do Discord.",
      invalidGamertag: "Gamertag inválida. Use de 2 a 32 caracteres visíveis.",
      unlinked: "Sua gamertag foi desvinculada.",
    },
  },
} as const;

export type MessageKey = `${keyof typeof messages.en}.${string}`;

export function normalizeLocale(locale?: string | null): Locale {
  return locale === "pt" ? "pt" : "en";
}

function readPath(source: any, path: string): string | undefined {
  return path.split(".").reduce((value, key) => value?.[key], source);
}

export function t(locale: Locale | string | undefined | null, key: string): string {
  const normalized = normalizeLocale(locale);
  return readPath(messages[normalized], key) || readPath(messages[DEFAULT_LOCALE], key) || key;
}
