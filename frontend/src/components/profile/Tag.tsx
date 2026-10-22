import type { ReactNode } from "react";

export const Tag = ({ children }: { children: ReactNode }) => <span className="tag" style={{ marginLeft: 6 }}>{children}</span>;
