import ActivityClient from "./ActivityClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Music Video Activity | AGOBOT" };

export default function MusicActivityPage() {
  // Application ID is public Discord OAuth data; the client secret never leaves the server.
  return <ActivityClient clientId={process.env.DISCORD_CLIENT_ID || ""} />;
}
