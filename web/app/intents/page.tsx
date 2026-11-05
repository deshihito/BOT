export const metadata = { title: "Privileged Gateway Intents — Use Cases | AGOBOT" };

export default function IntentsPage() {
  return (
    <article className="legal-page">
      <h1>Privileged Gateway Intents — Use Cases</h1>
      <p>
        This page provides use-case evidence for the privileged gateway intent
        request of the Discord application <strong>AGO BOT</strong> (Application
        ID: 1476636487784337428). AGO BOT is a multi-purpose Discord bot in
        production use in its support server and many other servers. How the bot
        collects, uses, and retains data is described in our{" "}
        <a href="/privacy">Privacy Policy</a>. Each section below shows one
        requested intent, screenshots of the feature working in a live server,
        and why the feature cannot work without that intent.
      </p>

      <h2>1. Server Members Intent</h2>
      <p>
        The screenshots below show the Server Assist settings of the{" "}
        <code>/support</code> panel (top, middle, and bottom of the feature
        list). The following admin-configured features run on member join and
        leave events, and therefore require the Server Members Intent:
      </p>
      <ul>
        <li>
          <strong>Join / leave messages</strong> — announce a member joining or
          leaving to a channel chosen by the server admins.
        </li>
        <li>
          <strong>Auto-role</strong> — automatically grant a configured role
          when a member joins.
        </li>
        <li>
          <strong>Server log</strong> — record joins, leaves, message deletions,
          and role / channel changes for the server admins.
        </li>
        <li>
          <strong>Invite tracker</strong> — record which invite link each new
          member used to join.
        </li>
        <li>
          <strong>Role restore (sticky roles)</strong> — save the roles of a
          member who leaves and restore them when the same user rejoins.
        </li>
      </ul>
      <img
        src="/img/intents/members-1.jpg"
        alt="Server Assist settings list, part 1: join/leave messages and auto-role on member join"
        style={{ width: "100%", height: "auto" }}
      />
      <img
        src="/img/intents/members-2.jpg"
        alt="Server Assist settings list, part 2: AutoMod, polls, server log and invite tracker"
        style={{ width: "100%", height: "auto" }}
      />
      <img
        src="/img/intents/members-3.jpg"
        alt="Server Assist settings list, part 3: role restore (sticky roles) and custom replies"
        style={{ width: "100%", height: "auto" }}
      />
      <p>
        Without this intent, member join / leave events are not delivered and
        the member cache is incomplete, so none of the features above can
        operate. Discord provides no alternative event source for joins and
        leaves.
      </p>

      <h2>2. Presence Intent</h2>
      <p>
        The screenshot below shows the &quot;activity frequency&quot; view of
        the survival check feature (<code>/fujo</code>), a welfare-check
        feature. It displays how often a registered user was detected as active
        (83 times in the last 24 hours, 373 times in the last 7 days, 635 times
        in the last 30 days), with the footer &quot;Survival Surveillance
        System&quot; and a note that detections are counted at most once every
        5 minutes.
      </p>
      <img
        src="/img/intents/presence.jpg"
        alt="Survival check activity frequency panel showing detection counts for the last 24 hours, 7 days and 30 days"
        style={{ width: "100%", height: "auto" }}
      />
      <p>
        This feature is opt-in only: it tracks solely users who explicitly
        registered for it, and they can unregister at any time. It detects signs
        of activity from three signals — sending a message, joining a voice
        channel, and presence status changes. If a registered user shows no
        activity for a period they configure themselves, the bot posts a message
        the user wrote in advance to a channel they chose, so their community
        can check on them. Many users are regularly online without ever sending
        messages or joining voice channels; for those users, a presence status
        change is the only detectable sign of life. Without the Presence Intent,
        the feature would falsely report active-but-silent users as missing, so
        its purpose cannot be achieved without this intent. Only the status
        value (for example &quot;online&quot;) and a timestamp are stored —
        never activities, game titles, or custom status text.
      </p>

      <h2>3. Message Content Intent</h2>
      <p>
        The first screenshot shows the bot&apos;s reply (a command list) to the
        text command <code>!help</code>. A large part of the bot&apos;s feature
        set is invoked as text (prefix) commands in chat, so the bot must be
        able to read the message text to execute them.
      </p>
      <img
        src="/img/intents/message-help.jpg"
        alt="The bot replying with a command list to the text command !help"
        style={{ width: "100%", height: "auto" }}
      />
      <p>
        The second screenshot shows the bot detecting another bot&apos;s
        successful <code>/up</code> post (from the listing bot Dissoku) and
        replying with an &quot;RTA record&quot; of up 6.79 seconds. The bot
        manages bump / up cooldown timers and notifications for server admins by
        detecting the success messages that listing bots post in the channel,
        which requires reading the content of messages posted by other bots.
      </p>
      <img
        src="/img/intents/message-bump.jpg"
        alt="The bot detecting another bot's /up success message and posting an RTA record of 6.79 seconds"
        style={{ width: "100%", height: "auto" }}
      />
      <p>
        Message content is processed in memory and is not stored as raw text in
        our external database. It is also required by message-based games (such
        as shiritori word chains), admin-configured NG-word / auto-moderation
        filters, keyword-triggered custom replies, and the opt-in
        auto-translation feature.
      </p>

      <p className="muted">
        Screenshots captured on 2026-11-05 in a live server where the bot
        operates. In the screenshots the bot appears as &quot;5分で死ぬbot&quot;,
        which is AGO BOT&apos;s in-server nickname.
      </p>
    </article>
  );
}
