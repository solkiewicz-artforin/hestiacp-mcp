import { describe, expect, it } from "vitest";
import { commandSpecs } from "../src/tools.js";

type Fixture = {
  input: Record<string, unknown>;
  command: string;
  args: string[];
};

const admin = { user: "admin" };
const zone = { ...admin, domain: "example.com" };

const fixtures: Record<string, Fixture> = {
  list_users: { input: {}, command: "v-list-users", args: ["json"] },
  get_user: { input: admin, command: "v-list-user", args: ["admin", "json"] },
  list_web_domains: { input: admin, command: "v-list-web-domains", args: ["admin", "json"] },
  get_web_domain: { input: zone, command: "v-list-web-domain", args: ["admin", "example.com", "json"] },
  list_dns_domains: { input: admin, command: "v-list-dns-domains", args: ["admin", "json"] },
  get_dns_domain: { input: zone, command: "v-list-dns-domain", args: ["admin", "example.com", "json"] },
  list_dns_records: { input: zone, command: "v-list-dns-records", args: ["admin", "example.com", "json"] },
  list_mail_domains: { input: admin, command: "v-list-mail-domains", args: ["admin", "json"] },
  get_mail_domain: { input: zone, command: "v-list-mail-domain", args: ["admin", "example.com", "json"] },
  list_mail_accounts: { input: zone, command: "v-list-mail-accounts", args: ["admin", "example.com", "json"] },
  list_databases: { input: admin, command: "v-list-databases", args: ["admin", "json"] },
  get_database: { input: { ...admin, database: "admin_app" }, command: "v-list-database", args: ["admin", "admin_app", "json"] },
  list_cron_jobs: { input: admin, command: "v-list-cron-jobs", args: ["admin", "json"] },
  list_user_backups: { input: admin, command: "v-list-user-backups", args: ["admin", "json"] },
  get_system_info: { input: {}, command: "v-list-sys-info", args: ["json"] },
  get_system_config: { input: {}, command: "v-list-sys-config", args: ["json"] },
  list_system_services: { input: {}, command: "v-list-sys-services", args: ["json"] },
  list_system_ips: { input: {}, command: "v-list-sys-ips", args: ["json"] },
  add_user: {
    input: { ...admin, password: "password123", email: "admin@example.com" },
    command: "v-add-user",
    args: ["admin", "password123", "admin@example.com", "default", "", ""]
  },
  add_web_domain: {
    input: zone,
    command: "v-add-web-domain",
    args: ["admin", "example.com", "", "yes", "", ""]
  },
  issue_web_certificate: {
    input: zone,
    command: "v-add-letsencrypt-domain",
    args: ["admin", "example.com", "", "no"]
  },
  add_dns_domain: {
    input: { ...zone, ip: "192.0.2.10" },
    command: "v-add-dns-domain",
    args: ["admin", "example.com", "192.0.2.10", "", "", "", "", "", "", "", "", "yes"]
  },
  add_dns_record: {
    input: { ...zone, record: "@", type: "MX", value: "mail.example.com" },
    command: "v-add-dns-record",
    args: ["admin", "example.com", "@", "MX", "mail.example.com", "10", "", "yes", "14400"]
  },
  add_mail_domain: {
    input: zone,
    command: "v-add-mail-domain",
    args: ["admin", "example.com", "yes", "yes", "yes", "2048", "yes", "no"]
  },
  add_mail_account: {
    input: { ...zone, account: "hello", password: "password123" },
    command: "v-add-mail-account",
    args: ["admin", "example.com", "hello", "password123", "unlimited"]
  },
  add_database: {
    input: { ...admin, database: "app", databaseUser: "app", password: "password123" },
    command: "v-add-database",
    args: ["admin", "app", "app", "password123", "mysql", "", "UTF8MB4"]
  },
  add_cron_job: {
    input: { ...admin, minute: "0", hour: "2", day: "*", month: "*", weekday: "*", command: "/usr/bin/true", confirm: true },
    command: "v-add-cron-job",
    args: ["admin", "0", "2", "*", "*", "*", "/usr/bin/true", "", "yes"]
  },
  backup_user: { input: admin, command: "v-backup-user", args: ["admin", "no"] },
  suspend_user: { input: { ...admin, confirm: true }, command: "v-suspend-user", args: ["admin", "yes"] },
  unsuspend_user: { input: admin, command: "v-unsuspend-user", args: ["admin", "yes"] },
  delete_user: { input: { ...admin, confirm: true }, command: "v-delete-user", args: ["admin", "yes"] },
  delete_web_domain: { input: { ...zone, confirm: true }, command: "v-delete-web-domain", args: ["admin", "example.com", "yes"] },
  delete_dns_domain: { input: { ...zone, confirm: true }, command: "v-delete-dns-domain", args: ["admin", "example.com"] },
  delete_dns_record: { input: { ...zone, id: 4, confirm: true }, command: "v-delete-dns-record", args: ["admin", "example.com", "4", "yes"] },
  delete_mail_domain: { input: { ...zone, confirm: true }, command: "v-delete-mail-domain", args: ["admin", "example.com"] },
  delete_mail_account: { input: { ...zone, account: "hello", confirm: true }, command: "v-delete-mail-account", args: ["admin", "example.com", "hello"] },
  delete_database: { input: { ...admin, database: "admin_app", confirm: true }, command: "v-delete-database", args: ["admin", "admin_app"] },
  delete_cron_job: { input: { ...admin, jobId: 3, confirm: true }, command: "v-delete-cron-job", args: ["admin", "3"] }
};

describe("command catalog", () => {
  it("has an exact default-argument fixture for every exposed tool", () => {
    expect(Object.keys(fixtures).sort()).toEqual(commandSpecs.map((spec) => spec.name).sort());
  });

  it("uses the PostgreSQL UTF8 default instead of MySQL UTF8MB4", () => {
    const spec = commandSpecs.find((candidate) => candidate.name === "add_database");
    if (spec === undefined) {
      throw new Error("Missing add_database spec");
    }
    const parsed = spec.schema.parse({
      ...admin,
      database: "app",
      databaseUser: "app",
      password: "password123",
      type: "pgsql"
    });
    expect(spec.args(parsed)).toEqual([
      "admin",
      "app",
      "app",
      "password123",
      "pgsql",
      "",
      "UTF8"
    ]);
  });

  for (const spec of commandSpecs) {
    it(`maps ${spec.name} to verified positional arguments`, () => {
      const fixture = fixtures[spec.name];
      if (fixture === undefined) {
        throw new Error(`Missing fixture for ${spec.name}`);
      }
      const parsed = spec.schema.parse(fixture.input);
      expect(spec.command).toBe(fixture.command);
      expect(spec.args(parsed)).toEqual(fixture.args);
      expect(fixture.args.length).toBeLessThanOrEqual(13);
    });
  }
});
