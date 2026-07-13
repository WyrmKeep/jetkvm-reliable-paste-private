export function normalizePasteText(text: string): string {
  const withoutBom = text.startsWith("\uFEFF") ? text.slice(1) : text;
  return withoutBom.replace(/\r\n?/g, "\n").normalize("NFC");
}
