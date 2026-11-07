import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";
import { JINROU_ROLES } from "@/lib/jinrou-roles";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const staticEntries: MetadataRoute.Sitemap = [
    { url: `${SITE_URL}/`, lastModified: now, changeFrequency: "weekly", priority: 1.0 },
    { url: `${SITE_URL}/commands`, lastModified: now, changeFrequency: "weekly", priority: 0.9 },
    { url: `${SITE_URL}/ranking`, lastModified: now, changeFrequency: "daily", priority: 0.8 },
    { url: `${SITE_URL}/jinrou/roles`, lastModified: now, changeFrequency: "monthly", priority: 0.7 },
    { url: `${SITE_URL}/privacy`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${SITE_URL}/terms`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
  ];
  const roleEntries: MetadataRoute.Sitemap = JINROU_ROLES.map((role) => ({
    url: `${SITE_URL}/jinrou/roles/${encodeURIComponent(role.id)}`,
    lastModified: now,
    changeFrequency: "monthly",
    priority: 0.5,
  }));
  return [...staticEntries, ...roleEntries];
}
