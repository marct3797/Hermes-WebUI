import type { AnchorHTMLAttributes, MouseEvent } from "react";
import { navigate } from "../router";

type Props = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & { to: string };

/** Interner Link: normaler <a> (Rechtsklick, neuer Tab), aber ohne Neuladen bei einfachem Klick. */
export function Link({ to, onClick, target, ...rest }: Props) {
  const click = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || target) return;
    e.preventDefault();
    navigate(to);
  };
  return <a href={to} target={target} onClick={click} {...rest} />;
}
