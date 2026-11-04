export const DEFAULT_ADMIN_LOGINS = ["imtiyazakiwat"] as const;
export const DEFAULT_ADMIN_EMAILS = ["imtiyazakiwat0@gmail.com"] as const;

/**
 * Check if a GitHub login is an admin.
 * Includes 'imtiyazakiwat' by default, plus any logins in ADMIN_LOGINS env var.
 */
export function isAdminLogin(login?: string | null, envLogins = process.env.ADMIN_LOGINS): boolean {
  if (!login) return false;
  const list = [
    ...DEFAULT_ADMIN_LOGINS,
    ...(envLogins ?? "").split(","),
  ]
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(login.trim().toLowerCase());
}

/**
 * Check if an email is an admin.
 * Includes 'imtiyazakiwat0@gmail.com' by default, plus any emails in ADMIN_EMAILS env var.
 */
export function isAdminEmail(email?: string | null, envEmails = process.env.ADMIN_EMAILS): boolean {
  if (!email) return false;
  const list = [
    ...DEFAULT_ADMIN_EMAILS,
    ...(envEmails ?? "").split(","),
  ]
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(email.trim().toLowerCase());
}

/**
 * Check if the user/session is an admin by either GitHub login or email.
 */
export function isAdmin(
  user?: { login?: string | null; email?: string | null } | null,
  env?: { logins?: string; emails?: string },
): boolean {
  if (!user) return false;
  return isAdminLogin(user.login, env?.logins) || isAdminEmail(user.email, env?.emails);
}
