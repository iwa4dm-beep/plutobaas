import type { PageHelp } from "@/lib/help/types";

// /dashboard/realtime — realtime channels, presence, CDC subscriptions.
// The legacy /dashboard/pluto-realtime slug redirects here.
export const dashboardRealtimeHelp: PageHelp = {
  slug: "dashboard.realtime",
  page: {
    title: { bn: "Realtime — channels, presence, CDC", en: "Realtime — channels, presence, CDC" },
    whatItDoes: {
      bn: "WebSocket-ভিত্তিক channel, broadcast message, user presence (online/away), এবং database CDC (INSERT/UPDATE/DELETE) subscription এখান থেকে তৈরি ও monitor করা যায়।",
      en: "Create and monitor WebSocket channels, broadcast messages, user presence (online/away), and database CDC (INSERT/UPDATE/DELETE) subscriptions.",
    },
    whyItMatters: {
      bn: "Chat, live cursor, collaboration, dashboard live-update — সবকিছুই এই layer-এর উপর দাঁড়ায়। Channel না থাকলে UI 'refresh চাপুন' habit-এ আটকে থাকে।",
      en: "Chat, live cursors, collaboration, live dashboards — all sit on this layer. Without channels, your UI stays stuck in a 'hit refresh' habit.",
    },
  },
  sections: [
    {
      id: "brief",
      title: { bn: "সংক্ষিপ্ত পরিচিতি", en: "Quick summary" },
      whatItDoes: {
        bn: "উপরে Channels list + '+ New channel'। প্রতিটি channel-এ Members (presence), Messages (broadcast log), CDC (subscribed tables) view।",
        en: "Top: channel list + '+ New channel'. Each channel exposes Members (presence), Messages (broadcast log), and CDC (subscribed tables).",
      },
    },
    {
      id: "channel",
      title: { bn: "Channel তৈরি ও broadcast", en: "Creating channels & broadcasting" },
      howToUse: [
        { bn: "ধাপ ১: '+ New channel' → নাম দিন (`room:123`, `orders:live` ইত্যাদি)।", en: "Step 1: '+ New channel' → name it (`room:123`, `orders:live` …)." },
        { bn: "ধাপ ২: channel বাছাই → 'Send test message' → payload JSON দিয়ে Send।", en: "Step 2: pick channel → 'Send test message' → JSON payload → Send." },
        { bn: "ধাপ ৩: client-এ `pluto.channel('room:123').on('broadcast', …).subscribe()` দিয়ে receive করুন।", en: "Step 3: from the client, `pluto.channel('room:123').on('broadcast', …).subscribe()`." },
      ],
    },
    {
      id: "presence",
      title: { bn: "Presence (online/away)", en: "Presence (online/away)" },
      whatItDoes: {
        bn: "Client-এর `.track({ status, meta })` কল করলে server-side presence table-এ user_id, shard, status update হয়। এখানে current member list ও status badge দেখা যায়।",
        en: "Client `.track({ status, meta })` calls upsert user_id, shard, and status server-side. This tab shows current members with status badges.",
      },
      howToUse: [
        { bn: "ধাপ ১: client join করার পর 'Members' tab-এ list দেখবেন।", en: "Step 1: after the client joins, watch the 'Members' tab populate." },
        { bn: "ধাপ ২: idle timeout / disconnect হলে row auto remove হয়।", en: "Step 2: idle/disconnect rows drop out automatically." },
      ],
    },
    {
      id: "cdc",
      title: { bn: "CDC — database change stream", en: "CDC — database change streams" },
      whatItDoes: {
        bn: "Table বাছাই করে postgres INSERT/UPDATE/DELETE event realtime-এ পাওয়া যায়। Filter দিয়ে (`column=eq.value`) noise কমান।",
        en: "Subscribe to a table and stream postgres INSERT/UPDATE/DELETE events. Use filters (`column=eq.value`) to cut noise.",
      },
      howToUse: [
        { bn: "ধাপ ১: 'CDC' tab → '+ Subscribe' → schema/table বাছাই।", en: "Step 1: 'CDC' tab → '+ Subscribe' → pick schema/table." },
        { bn: "ধাপ ২: event type ও filter দিন → Save।", en: "Step 2: pick event type + filter → Save." },
        { bn: "ধাপ ৩: live event stream 'Events' panel-এ দেখবেন।", en: "Step 3: watch the live event stream in the 'Events' panel." },
      ],
      troubleshooting: [
        { problem: { bn: "CDC event আসছে না", en: "No CDC events arriving" }, solution: { bn: "Table-এ realtime enable করা আছে কিনা confirm করুন (Database → Replication)।", en: "Confirm the table has realtime enabled (Database → Replication)." } },
        { problem: { bn: "Ghost presence — user disconnect করেও আছে", en: "Ghost presence — user shows online after disconnect" }, solution: { bn: "Idle sweep interval (60s default) পর্যন্ত অপেক্ষা করুন; manual purge করতে চাইলে row 'Kick'।", en: "Wait one idle sweep (~60s), or click 'Kick' on the row to force-drop." } },
      ],
    },
  ],
  glossary: [
    { term: "channel", definition: { bn: "একটা নামযুক্ত pubsub topic যেখানে client subscribe করে।", en: "A named pubsub topic that clients subscribe to." } },
    { term: "broadcast", definition: { bn: "Channel-এর সব subscriber-এ একই message পাঠানো।", en: "Sending the same message to every subscriber on a channel." } },
    { term: "CDC", definition: { bn: "Change Data Capture — database row change stream।", en: "Change Data Capture — a stream of row-level DB changes." } },
    { term: "presence", definition: { bn: "কে এখন channel-এ আছে সেটা track করার metadata।", en: "Metadata tracking who is currently on a channel." } },
  ],
};
