/**
 * Synthetic posts for the MockConnector. Entirely invented: never real scraped posts. Themes echo the public
 * record of the 2014 outbreak (e.g. the salt-water bathing scare, rumours about cases in a hospital, burial
 * fears) so the UI has realistic, varied material. Some posts carry fake handles, links and phone numbers on
 * purpose, to exercise the PII scrubber.
 *
 * NOTE: the mock classifier assigns results by hashing the item id, not by reading the text, so these
 * texts and their labels are not related. That is exactly what the MOCK DATA badge is for.
 */
export interface SyntheticPost {
  text: string;
  language: 'en' | 'pcm' | 'ha' | 'yo' | 'ig' | 'fr' | 'und';
  state: string | null;
  lga: string | null;
}

export const SYNTHETIC_CORPUS: SyntheticPost[] = [
  {
    text: 'Bathe with hot salt water at dawn and drink a cup. That is how you stay safe from Ebola. Share with everyone you love! @naija_family_tips',
    language: 'en',
    state: 'Lagos',
    lga: 'Ikeja',
  },
  {
    text: 'Dem say make you bath with hot salt water for morning, Ebola no go touch you. Share am give everybody!',
    language: 'pcm',
    state: 'Rivers',
    lga: 'Port Harcourt',
  },
  {
    text: 'Is it true that drinking salt water protects you from Ebola? My neighbour says the clinic told her so.',
    language: 'en',
    state: 'Enugu',
    lga: 'Enugu North',
  },
  {
    text: 'Ana cewa shan ruwan gishiri yana kare mutum daga Ebola. Gaskiya ne?',
    language: 'ha',
    state: 'Kano',
    lga: 'Nassarawa',
  },
  {
    text: 'Won ni omi iyọ̀ ń dáàbò bo ni lọ́wọ́ Ebola. Ṣé òótọ́ ni?',
    language: 'yo',
    state: 'Oyo',
    lga: 'Ibadan North',
  },
  {
    text: "Ha na-ekwu na ịṅụ mmiri nnu na-echebe mmadụ pụọ n'Ebola. Ọ bụ eziokwu?",
    language: 'ig',
    state: 'Anambra',
    lga: 'Awka South',
  },
  {
    text: "On dit que l'Ebola n'existe pas, que c'est un mensonge pour voler l'argent du gouvernement.",
    language: 'fr',
    state: null,
    lga: null,
  },
  {
    text: 'Ebola is a lie. There is no outbreak, the government just wants donor money. Do not let them into your street.',
    language: 'en',
    state: 'Lagos',
    lga: 'Surulere',
  },
  {
    text: 'BREAKING: 5 confirmed Ebola cases at the general hospital this morning, they are hiding it from us. Call 0803 000 0000 for details.',
    language: 'en',
    state: 'FCT',
    lga: 'Gwagwalada',
  },
  {
    text: 'Abeg no go that hospital o, dem say Ebola patients dey there but na secret. See https://example.com/secret-list',
    language: 'pcm',
    state: 'Lagos',
    lga: 'Apapa',
  },
  {
    text: 'Official notice: all schools to close for 3 weeks, signed by the Ministry. Forward to your contacts. see bit.ly/closed-schools',
    language: 'en',
    state: 'Kaduna',
    lga: 'Kaduna North',
  },
  {
    text: 'They want to bury our people without our rites. We will not allow the burial team into the compound.',
    language: 'en',
    state: 'Rivers',
    lga: 'Obio-Akpor',
  },
  {
    text: 'Do not shake hands with anyone from the affected area, and keep their children away from yours. Mail alerts@fake-example.com',
    language: 'en',
    state: 'Oyo',
    lga: 'Ibadan South-West',
  },
  {
    text: 'The vaccine trial is a test on Africans. Refuse it, my cousin says it makes people sick.',
    language: 'en',
    state: 'Kano',
    lga: 'Fagge',
  },
  {
    text: 'Ebola came from a government laboratory, they released it on purpose. Wake up people!',
    language: 'en',
    state: 'Ogun',
    lga: 'Abeokuta South',
  },
  {
    text: 'NCDC says wash your hands often with soap and water and report anyone with fever and bleeding to the nearest clinic.',
    language: 'en',
    state: 'FCT',
    lga: 'Abuja Municipal',
  },
  {
    text: 'Fact check: salt water does NOT prevent or cure Ebola. Please do not share this rumour. Wash hands with soap instead.',
    language: 'en',
    state: 'Lagos',
    lga: 'Eti-Osa',
  },
  {
    text: 'Ebola can spread through the air like cold, stay indoors and cover your mouth with cloth always.',
    language: 'en',
    state: 'Anambra',
    lga: 'Onitsha North',
  },
  {
    text: 'Please who has the correct number for the state Ebola hotline? I only see different numbers on WhatsApp.',
    language: 'en',
    state: 'Enugu',
    lga: 'Enugu South',
  },
  {
    text: 'Wetin be di symptom of Ebola sef? Na only fever or e get other tin?',
    language: 'pcm',
    state: 'Delta',
    lga: 'Warri South',
  },
  {
    text: 'Match report: the Super Eagles drew 1-1 last night, what a game!',
    language: 'en',
    state: 'Kaduna',
    lga: 'Zaria',
  },
  {
    text: 'Jollof rice or ofada? This debate will never end 😂',
    language: 'en',
    state: 'Lagos',
    lga: 'Yaba',
  },
  {
    text: 'Ana yada jita-jita cewa an samu mai Ebola a asibiti, kar ku je can. Kira 0805 000 0000',
    language: 'ha',
    state: 'Kaduna',
    lga: 'Chikun',
  },
  { text: '🧂💧🙏 #Ebola', language: 'und', state: null, lga: null },
];

export const SYNTHETIC_PLATFORMS = ['bluesky', 'x', 'youtube', 'instagram'] as const;
