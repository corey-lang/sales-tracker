export type UserRole = "admin" | "assistant" | "ae";

export function isUserRole(value: unknown): value is UserRole {
  return value === "admin" || value === "assistant" || value === "ae";
}
