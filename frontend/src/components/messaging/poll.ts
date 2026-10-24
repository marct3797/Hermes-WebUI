/** Abstand der Abfragen bei laufenden Vorgängen (Gateway-Befehl, Telegram-Kopplung). In Tests kurz, damit sie nicht warten. */
export const POLL_MS = import.meta.env.MODE === "test" ? 15 : 2000;
export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
