import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";
import { JINROU_ROLES } from "@/lib/jinrou-roles";
import { COMMAND_GUIDES } from "@/lib/command-guides";
import { playableGames } from "@/lib/games-catalog";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const staticEntries: MetadataRoute.Sitemap = [
    { url: `${SITE_URL}/`, lastModified: now, changeFrequency: "weekly", priority: 1.0 },
    { url: `${SITE_URL}/commands`, lastModified: now, changeFrequency: "weekly", priority: 0.9 },
    { url: `${SITE_URL}/games`, lastModified: now, changeFrequency: "weekly", priority: 0.8 },
    { url: `${SITE_URL}/features`, lastModified: now, changeFrequency: "weekly", priority: 0.8 },
    { url: `${SITE_URL}/ranking`, lastModified: now, changeFrequency: "daily", priority: 0.8 },
    { url: `${SITE_URL}/compute`, lastModified: now, changeFrequency: "monthly", priority: 0.5 },
    { url: `${SITE_URL}/one-prompter`, lastModified: now, changeFrequency: "monthly", priority: 0.5 },
    { url: `${SITE_URL}/status`, lastModified: now, changeFrequency: "daily", priority: 0.6 },
    { url: `${SITE_URL}/jinrou/roles`, lastModified: now, changeFrequency: "monthly", priority: 0.7 },
    { url: `${SITE_URL}/privacy`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${SITE_URL}/terms`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
    { url: `${SITE_URL}/credits`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
  ];
  const gameEntries: MetadataRoute.Sitemap = playableGames().map((game) => ({
    url: `${SITE_URL}/games/${game.slug}`,
    lastModified: now,
    changeFrequency: "monthly" as const,
    priority: 0.7,
  }));
  const roleEntries: MetadataRoute.Sitemap = JINROU_ROLES.map((role) => ({
    url: `${SITE_URL}/jinrou/roles/${encodeURIComponent(role.id)}`,
    lastModified: now,
    changeFrequency: "monthly",
    priority: 0.5,
  }));
  const commandEntries: MetadataRoute.Sitemap = COMMAND_GUIDES.map((guide) => ({
    url: `${SITE_URL}/commands/${guide.slug}`,
    lastModified: now,
    changeFrequency: "monthly",
    priority: 0.7,
  }));
  const genreEntries: MetadataRoute.Sitemap = COMMAND_GUIDES.flatMap((guide) =>
    guide.genres.map((genre) => ({
      url: `${SITE_URL}/commands/${guide.slug}/${genre.slug}`,
      lastModified: now,
      changeFrequency: "monthly" as const,
      priority: 0.6,
    })),
  );
  return [...staticEntries, ...gameEntries, ...roleEntries, ...commandEntries, ...genreEntries];
}
