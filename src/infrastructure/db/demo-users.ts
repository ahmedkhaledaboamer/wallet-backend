import type { Role } from "../../domain/network";

/**
 * Demo users for DEMO_AUTH=true. Only the sha256 of each token is stored in the
 * database; GET /demo/users returns these plaintext tokens so the frontend's
 * role switcher works. Never enable DEMO_AUTH outside a demo.
 */
export interface DemoUser {
  id: string;
  name: string;
  role: Role;
  token: string;
}

export const DEMO_USERS: DemoUser[] = [
  { id: "usr_sara_haddad", name: "Sara Haddad", role: "maker", token: "demo-maker-sara-7f3c9a2b41d6e8f05a1c" },
  { id: "usr_omar_khalil", name: "Omar Khalil", role: "checker", token: "demo-checker-omar-2b8e4d6f0a1c3e5b7d9f" },
  { id: "usr_lina_mansour", name: "Lina Mansour", role: "executor", token: "demo-executor-lina-9c1e3a5b7d0f2e4a6c8b" },
  { id: "usr_youssef_amin", name: "Youssef Amin", role: "maker", token: "demo-maker-youssef-4d6f8a0c2e1b3d5f7a9c" },
];
