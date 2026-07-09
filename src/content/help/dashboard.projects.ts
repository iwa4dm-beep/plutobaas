import type { PageHelp } from "@/lib/help/types";

export const dashboardProjectsHelp: PageHelp = {
  slug: "dashboard.projects",
  page: {
    title: { bn: "প্রজেক্ট ও API কী", en: "Projects & API Keys" },
    whatItDoes: {
      bn: "প্রতিটি ওয়ার্কস্পেসের অধীনে প্রজেক্ট তৈরি এবং প্রতিটির জন্য anon/service_role API কী issue ও revoke করা হয়।",
      en: "Create projects inside a workspace and mint/revoke anon and service_role API keys for each one.",
    },
    whyItMatters: {
      bn: "সঠিক কী ম্যানেজমেন্ট ছাড়া client apps auth পাবে না এবং leaked service_role key পুরো ডেটাবেসে অ্যাক্সেস দিয়ে দেয়।",
      en: "Without correct key management, client apps cannot authenticate, and a leaked service_role key exposes the entire database.",
    },
  },
  sections: [
    {
      id: "create-project",
      title: { bn: "নতুন প্রজেক্ট তৈরি", en: "Create a project" },
      whatItDoes: {
        bn: "একটি workspace বেছে নিয়ে নাম ও slug দিয়ে নতুন প্রজেক্ট তৈরি করুন।",
        en: "Pick a workspace, enter a name and slug, then create the project.",
      },
      howToUse: [
        { bn: "উপরের dropdown থেকে workspace বেছে নিন।", en: "Select a workspace from the dropdown at top." },
        { bn: "প্রজেক্টের নাম ও unique slug লিখুন।", en: "Enter a project name and unique slug." },
        { bn: "Create চাপুন — লিস্টে সাথে সাথে দেখা যাবে।", en: "Click Create — it appears in the list immediately." },
      ],
      fields: [
        { name: "name", purpose: { bn: "human-friendly প্রজেক্ট নাম", en: "Human-friendly project name" } },
        { name: "slug", purpose: { bn: "URL-safe unique identifier", en: "URL-safe unique identifier" }, example: "web-prod" },
      ],
    },
    {
      id: "mint-keys",
      title: { bn: "API কী issue করা", en: "Mint API keys" },
      whatItDoes: {
        bn: "anon কী client apps-এর জন্য এবং service_role কী শুধু server-side কাজে ব্যবহার করুন।",
        en: "Use the anon key for client apps and the service_role key strictly server-side.",
      },
      howToUse: [
        { bn: "Key type নির্বাচন করুন (anon বা service_role)।", en: "Choose key type (anon or service_role)." },
        { bn: "একটি label দিন যাতে পরে identify করা যায়।", en: "Add a label so future-you can identify the key." },
        { bn: "Mint চাপুন এবং plaintext key একবারই কপি করে সংরক্ষণ করুন।", en: "Click Mint and copy the plaintext once — it is shown only that one time." },
      ],
      troubleshooting: [
        {
          problem: { bn: "Plaintext কী হারিয়ে গেছে", en: "Lost the plaintext key" },
          solution: {
            bn: "পুরনো কী revoke করে নতুন issue করুন — plaintext আর দেখানো যাবে না।",
            en: "Revoke the old key and mint a new one — the plaintext cannot be recovered.",
          },
        },
      ],
    },
    {
      id: "rotate-revoke",
      title: { bn: "রোটেট ও revoke", en: "Rotate & revoke" },
      whatItDoes: {
        bn: "কী compromised হলে সাথে সাথে revoke করুন এবং নতুন issue করে apps update করুন।",
        en: "Revoke a key the moment it may be compromised, mint a fresh one, and roll it out to apps.",
      },
    },
  ],
  glossary: [
    { term: "anon key", definition: { bn: "Client-side ব্যবহারযোগ্য পাবলিক কী — RLS মানে।", en: "Public client-side key that respects RLS." } },
    { term: "service_role", definition: { bn: "RLS bypass করে — শুধু server-side ব্যবহার করুন।", en: "Bypasses RLS — server-side use only." } },
  ],
};
