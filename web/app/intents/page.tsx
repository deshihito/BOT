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
        This re-application is limited to use cases in which the message
        author never invokes our bot: the message was posted by a different
        bot, an admin pre-configured a rule that must act on ordinary
        conversation, or the ordinary conversation itself is the input or the
        payload. Our legacy text (prefix) commands are <strong>not</strong>{" "}
        part of this request — 181 of the 183 actions in our action registry
        are already reachable through application commands — and neither are
        the parts of our moderation that duplicate Discord&apos;s built-in
        AutoMod (invite-link, external-link and mention-spam checks). The five
        screenshots in this section were captured on 2026-11-10 in a live
        server where the bot operates.
      </p>

      <h3>Image 1 — Detection of other bots&apos; bump / up success messages</h3>
      <p>
        Server-listing bots such as DISBOARD and Dissoku post a success
        message when a server is bumped. Those bots never mention our bot, and
        bots cannot invoke each other&apos;s application commands. Our bot
        reads the success embed, starts that server&apos;s bump cooldown
        timer, schedules the reminder notification, and records the result in
        an RTA (speedrun) leaderboard. Without this intent, another bot&apos;s
        message that does not mention ours is delivered with its embed empty,
        so this detection is impossible.
      </p>
      <figure>
        <img
          src="/img/intents/message-bump.jpg"
          alt="The bot detecting another listing bot's bump/up success message and posting an RTA record"
          style={{ width: "100%", height: "auto" }}
        />
        <figcaption>
          Image 1 — Bump / up detection: another listing bot&apos;s success
          message is detected, and the cooldown timer and RTA record are
          started.
        </figcaption>
      </figure>

      <h3>Image 2 — Cross-server global chat relay, gated by a pre-relay filter</h3>
      <p>
        Channels that server admins register are linked across servers, and
        ordinary messages posted in one server are relayed to the linked
        channels in other servers under the author&apos;s name and avatar —
        the message text itself is the payload, so there is no invocation
        step a slash command could replace. Before any message is relayed, it
        is checked against blocked-word lists, including each destination
        server&apos;s own list applied to a message it did not originate.
        Discord&apos;s built-in AutoMod acts only inside the server where a
        message was posted; it cannot apply a different server&apos;s word
        list, and it cannot decide whether a message may leave its server.
      </p>
      <figure>
        <img
          src="/img/intents/message-globalchat.jpg"
          alt="Global chat: relayed conversation, a message stopped by the pre-relay filter, and the destination channel where it never arrived"
          style={{ width: "100%", height: "auto" }}
        />
        <figcaption>
          Image 2 — Cross-server global chat: (top) relayed conversation
          flowing between servers; (middle) a message stopped by the
          pre-relay filter, marked as blocked; (bottom) the destination
          server&apos;s global-chat channel, where the stopped message never
          arrived.
        </figcaption>
      </figure>

      <h3>Image 3 — Opt-in auto-translation of a user&apos;s own messages</h3>
      <p>
        A user who has explicitly opted in (the setting is off by default,
        and the user chooses the source and target languages) simply speaks
        in their own language: each of their ordinary messages is translated,
        the original is deleted, and the translation is reposted via a
        channel webhook under the user&apos;s own name and avatar. A message
        context menu command translates a single message that a reader
        selects after the fact; it cannot replace the speaker&apos;s own
        messages in the flow of a live conversation. Translation runs on our
        self-hosted LibreTranslate instance, so the text is not sent to any
        third-party translation service.
      </p>
      <figure>
        <img
          src="/img/intents/message-translation.jpg"
          alt="Auto-translation settings switched ON (Japanese to English) and a message reposted in English under the user's own name and avatar"
          style={{ width: "100%", height: "auto" }}
        />
        <figcaption>
          Image 3 — Opt-in auto-translation: the setting switched ON
          (Japanese → English), and the user&apos;s message reposted in
          English under their own name and avatar.
        </figcaption>
      </figure>

      <h3>Image 4 — Admin moderation logs: deleted / edited messages and cross-channel flood detection</h3>
      <p>
        The content of a deleted message exists for our bot only in the copy
        delivered when the message was originally posted: once a message is
        deleted, no command or API call can retrieve its text after the fact.
        Where server admins enable this feature, the bot posts the text of
        deleted messages and the before / after text of edited messages to
        an admin-only log channel. The same log channel also receives the
        moderation detections that compare messages across time, channels and
        users — checks the AutoMod API has no trigger for, such as
        cross-channel flooding: the same user posting the same text in
        multiple channels within 60 seconds.
      </p>
      <figure>
        <img
          src="/img/intents/message-modlog.jpg"
          alt="AutoMod settings with cross-channel flood detection enabled, and deleted / edited message records in the admin log channel"
          style={{ width: "100%", height: "auto" }}
        />
        <figcaption>
          Image 4 — Admin moderation logs: (top) AutoMod settings showing
          the cross-channel flood detection (same text 3 times within 60
          seconds across multiple channels); (below) deleted message content
          and before / after edit records in the admin log channel.
        </figcaption>
      </figure>

      <h3>Image 5 — Resident (always-on) shiritori in admin-designated channels</h3>
      <p>
        In up to five channels per server that an admin designates, our
        word-chain game runs continuously: there is no game session and no
        start action, so every ordinary message in the channel is a
        potential move. A message consisting of a kana word is treated as a
        move and checked against the current chain; ordinary chat that is
        not a kana word is silently ignored. The bot must therefore read the
        content of every message in those channels simply to tell moves from
        chat; it tracks the chain in the background and posts a notice only
        when a chain breaks, showing the chain length reached and the
        channel&apos;s record.
      </p>
      <figure>
        <img
          src="/img/intents/message-shiritori.jpg"
          alt="Resident shiritori: kana messages continuing the chain in a designated channel and a break notice showing the chain length and record"
          style={{ width: "100%", height: "auto" }}
        />
        <figcaption>
          Image 5 — Resident shiritori: kana messages continue the chain in
          an admin-designated channel; a break notice shows the chain length
          reached and the channel record.
        </figcaption>
      </figure>

      <p>
        Two further use cases are described in our application without
        screenshots: an NG-word game in which a participant is eliminated
        for using an assigned secret word in natural conversation, and
        admin-defined keyword automation, where a phrase appearing anywhere
        in an ordinary message triggers a combined reply, reaction and / or
        role grant that AutoMod&apos;s block / alert / timeout actions
        cannot perform. Message content is processed in memory only and is
        never stored as raw text in our external database; it is sent to a
        third party only when a user explicitly invokes an AI feature.
      </p>

      <p className="muted">
        Screenshots captured on 2026-11-05 in a live server where the bot
        operates. In the screenshots the bot appears as &quot;5分で死ぬbot&quot;,
        which is AGO BOT&apos;s in-server nickname.
      </p>
    </article>
  );
}
