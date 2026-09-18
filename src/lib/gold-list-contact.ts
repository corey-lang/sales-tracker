/** Preserve the displayed number while making common extension notation dialable. */
export function goldListPhoneHref(phone: string): string {
  const value = phone.trim().replace(/\s*(?:ext\.?|extension|x)\s*(\d+)$/i, ";ext=$1");
  return `tel:${value.replace(/\s/g, "")}`;
}

/** A literal # or ? in a mailbox must not become a URI fragment or query. */
export function goldListEmailHref(email: string): string {
  return `mailto:${encodeURIComponent(email.trim()).replace(/%40/g, "@")}`;
}
