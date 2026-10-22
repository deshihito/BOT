import { redirect } from "next/navigation";
import { getCurrentUser, isDiscordConfigured } from "@/lib/auth";

export const metadata = { title: "ログイン | AGOBOT" };

type LoginPageProps = {
  searchParams: Promise<{ error?: string }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  if (await getCurrentUser()) redirect("/dashboard");
  const { error } = await searchParams;

  return (
    <section className="login-page">
      <h1>ログイン</h1>
      {isDiscordConfigured() ? <a className="discord-login-button" href="/api/auth/discord/authorize">Discordでログイン</a> : null}
      {error ? <p className="login-error" role="alert">ログインできませんでした。</p> : null}
    </section>
  );
}
