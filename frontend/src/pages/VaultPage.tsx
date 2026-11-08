import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { PageHead } from "../components/PageHead";
import { useAction } from "../components/useAction";
import type { AgentRef, SecretsProvider, SecretsView, VaultItem, VaultList } from "../types";
import { t } from "../i18n";

const PAYMENT = ["card_number", "cardholder_name", "exp_month", "exp_year", "cvc", "billing_postal_code"] as const;
const ADDRESS = ["address_line1", "address_line2", "city", "state", "postal_code", "country"] as const;
const FIELD_LABEL: Record<string, string> = {
  card_number: "Kartennummer", cardholder_name: "Name auf der Karte", exp_month: "Ablauf Monat", exp_year: "Ablauf Jahr", cvc: "Prüfziffer", billing_postal_code: "Postleitzahl der Rechnung",
  address_line1: "Adresszeile 1", address_line2: "Adresszeile 2", city: "Ort", state: "Bundesland", postal_code: "Postleitzahl", country: "Land",
};
const REQUIRED: Record<string, readonly string[]> = { payment: ["card_number", "exp_month", "exp_year", "cvc"], address: ["address_line1", "city", "postal_code", "country"] };
const label = (k: string) => t(FIELD_LABEL[k] ?? k);

function VaultSection({ agent }: { agent: AgentRef }) {
  const [list, setList] = useState<VaultList | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [kind, setKind] = useState<VaultItem["kind"]>("login");
  const [name, setName] = useState("");
  const [origin, setOrigin] = useState("");
  const [idType, setIdType] = useState("email");
  const [ident, setIdent] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});
  const { run, notes, busy } = useAction();
  const load = useCallback(() => api.vaultList(agent).then((l) => { setList(l); setLoadErr(""); }, (e: Error) => { setLoadErr(e.message); }), [agent.host, agent.runtime, agent.agent]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [load]);

  const names: readonly string[] = kind === "payment" ? PAYMENT : ADDRESS;
  const ready = name.trim() && (kind === "login" ? origin.trim() && ident.trim() && password : (REQUIRED[kind] ?? []).every((k) => fields[k]?.trim()));
  const add = async () => {
    const ok = await run(async () => {
    const body = kind === "login"
      ? { kind, label: name.trim(), origin: origin.trim(), identifier_type: idType, identifier: ident.trim(), password, ...(otp.trim() ? { otp_secret: otp.trim() } : {}) }
      : { kind, label: name.trim(), origin: origin.trim(), fields };
    await api.vaultAdd(agent, body);
    setName(""); setOrigin(""); setIdent(""); setPassword(""); setOtp(""); setFields({});   // Geheimnisse sofort aus dem Speicher der Maske
    await load();
    });
    if (!ok) void load();   // nach Zeitüberschreitung oder 502 ist unklar, ob der Eintrag schon liegt: nachsehen, nicht blind noch einmal senden
  };

  return (
    <section aria-label={t("Tresor")}>
      <h2>{t("Lokaler Tresor")}</h2>
      <p className="muted">{t("Der Agent sieht nur Kennungen und Adressen. Passwörter und Kartendaten werden verschlüsselt gespeichert, nie angezeigt und nie in den Chat gegeben.")}</p>
      {list?.key_storage && <p className="muted">{list.key_storage === "keychain" ? t("Schlüssel im Schlüsselbund des Systems") : t("Schlüssel in einer Datei neben dem Tresor")}</p>}
      {notes}
      {loadErr && <p className="banner" role="alert">{loadErr}</p>}
      {list && list.items.length === 0 && <p>{t("Der Tresor ist leer.")}</p>}
      <ul>{(list?.items ?? []).map((i) => (
        <li key={i.id}>
          <strong>{i.label}</strong> <span className="muted">{i.kind}{i.origin ? ` · ${i.origin}` : ""}{i.identifier ? ` · ${i.identifier}` : ""}</span>
          <input aria-label={t("Zum Löschen den Namen eintippen: {name}", { name: i.label })} placeholder={i.label} value={typed[i.id] ?? ""} onChange={(e) => { const v = e.target.value; setTyped((o) => ({ ...o, [i.id]: v })); }} />
          <button type="button" disabled={busy || typed[i.id]?.trim() !== i.label} onClick={() => void run(async () => { await api.vaultRemove(agent, i.id, i.label); setTyped((o) => ({ ...o, [i.id]: "" })); await load(); })}>{t("Löschen {name}", { name: i.label })}</button>
        </li>))}</ul>
      <h3>{t("Neuer Eintrag")}</h3>
      <label>{t("Art")} <select aria-label={t("Art")} value={kind} onChange={(e) => { setKind(e.target.value as VaultItem["kind"]); setFields({}); }}>
        <option value="login">{t("Login")}</option><option value="payment">{t("Zahlungskarte")}</option><option value="address">{t("Adresse")}</option></select></label>
      <label>{t("Name")} <input aria-label={t("Name des Eintrags")} value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label>{t("Adresse der Seite")} <input aria-label={t("Adresse der Seite")} placeholder="https://github.com" value={origin} onChange={(e) => setOrigin(e.target.value)} /></label>
      {kind === "login" ? <>
        <label>{t("Kennung")} <select aria-label={t("Art der Kennung")} value={idType} onChange={(e) => setIdType(e.target.value)}>
          <option value="email">{t("E-Mail")}</option><option value="username">{t("Benutzername")}</option><option value="phone">{t("Telefon")}</option></select></label>
        <input aria-label={t("Kennung")} autoComplete="off" value={ident} onChange={(e) => setIdent(e.target.value)} />
        <label>{t("Passwort")} <input type="password" aria-label={t("Passwort")} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        <label>{t("Authenticator-Schlüssel (optional)")} <input type="password" aria-label={t("Authenticator-Schlüssel")} autoComplete="off" value={otp} onChange={(e) => setOtp(e.target.value)} /></label>
      </> : names.map((k) => (
        <label key={k}>{label(k)}{REQUIRED[kind]?.includes(k) ? " *" : ""} <input type={kind === "payment" ? "password" : "text"} aria-label={label(k)} autoComplete="off" value={fields[k] ?? ""} onChange={(e) => { const v = e.target.value; setFields((o) => ({ ...o, [k]: v })); }} /></label>))}
      <button type="button" disabled={busy || !ready} onClick={() => void add()}>{t("Im Tresor speichern")}</button>
    </section>
  );
}

const PROVIDERS: Array<{ id: SecretsProvider; name: string }> = [{ id: "bitwarden", name: "Bitwarden" }, { id: "onepassword", name: "1Password" }];

function SecretsBlock({ agent, provider, title }: { agent: AgentRef; provider: SecretsProvider; title: string }) {
  const [view, setView] = useState<SecretsView | null>(null);
  const [word, setWord] = useState("");
  const [env, setEnv] = useState("");
  const [ref, setRef] = useState("");
  const [rm, setRm] = useState("");
  const { run, notes, busy } = useAction();
  const op = provider === "onepassword";
  const status = () => run(async () => { setView(await api.secretsStatus(agent, provider)); });
  const change = (body: Parameters<typeof api.secretsChange>[2]) => run(async () => { setView(await api.secretsChange(agent, provider, body)); });
  return (
    <section aria-label={title}>
      <h3>{title}</h3>
      {notes}
      <button type="button" disabled={busy} onClick={() => void status()}>{t("Status von {name} prüfen", { name: title })}</button>
      <button type="button" disabled={busy} onClick={() => void run(async () => { setView(await api.secretsSync(agent, provider)); })}>{t("Probelauf für {name}", { name: title })}</button>
      {view && <pre aria-label={t("Ausgabe {name}", { name: title })}>{view.output}{view.truncated ? "\n…" : ""}</pre>}
      {op && <>
        <label>{t("Variable")} <input aria-label={t("Variable für {name}", { name: title })} placeholder="OPENAI_API_KEY" value={env} onChange={(e) => setEnv(e.target.value.toUpperCase())} /></label>
        <label>{t("Referenz")} <input aria-label={t("Referenz für {name}", { name: title })} placeholder="op://Private/OpenAI/api key" value={ref} onChange={(e) => setRef(e.target.value)} /></label>
        <button type="button" disabled={busy || !/^[A-Z][A-Z0-9_]*$/.test(env) || !ref.trim().startsWith("op://")} onClick={() => void change({ action: "set", env_var: env, reference: ref.trim() }).then((ok) => { if (ok) { setEnv(""); setRef(""); } })}>{t("Zuordnung speichern")}</button>
        <input aria-label={t("Zum Entfernen den Variablennamen eintippen")} value={rm} onChange={(e) => setRm(e.target.value)} />
        <button type="button" disabled={busy || !/^[A-Z][A-Z0-9_]*$/.test(rm.trim())} onClick={() => void change({ action: "remove", env_var: rm.trim(), confirm: rm.trim() }).then((ok) => { if (ok) setRm(""); })}>{t("Zuordnung entfernen")}</button>
      </>}
      <input aria-label={t("Zum Ausschalten „ausschalten“ eintippen: {name}", { name: title })} placeholder={t("ausschalten")} value={word} onChange={(e) => setWord(e.target.value)} />
      <button type="button" disabled={busy || word.trim() !== "ausschalten"} onClick={() => void change({ action: "disable", confirm: word.trim() }).then((ok) => { if (ok) setWord(""); })}>{t("{name} ausschalten", { name: title })}</button>
    </section>
  );
}

export default function VaultPage({ agent }: { agent: AgentRef }) {
  return (
    <article>
      <PageHead title={t("Tresor und Geheimnisse")} sub={t("Zugangsdaten, die nie im Chat landen")} />
      <VaultSection agent={agent} />
      <section aria-label={t("Secrets-Anbieter")}>
        <h2>{t("Secrets-Anbieter")}</h2>
        <p className="muted">{t("Hermes holt Schlüssel beim Start aus dem Anbieter, statt sie in der .env zu speichern. Einschalten und Token setzen geht über die Hermes-Einstellungen und die Schlüssel-Seite; hier prüfst und pflegst du.")}</p>
        {PROVIDERS.map((p) => <SecretsBlock key={p.id} agent={agent} provider={p.id} title={p.name} />)}
      </section>
    </article>
  );
}
