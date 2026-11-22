/**
 * The codes each provider documents for a country or a language, as its
 * reference lists them. A search states a country as an ISO 3166-1 alpha-2
 * code and a language as an ISO 639-1 code; a provider is sent one only when
 * its list has it.
 */

function codes(list: string): ReadonlySet<string> {
  return new Set(list.split(" "));
}

/** The countries Brave localizes for. */
export const BRAVE_COUNTRIES = codes(
  "AR AU AT BE BR CA CL DK FI FR DE GR HK IN ID IT JP KR MY MX NL NZ NO CN " +
    "PL PT PH RU SA ZA ES SE CH TW TR GB US",
);

/** The countries You.com and Valyu localize for: the two publish the same list. */
export const YOU_COUNTRIES = codes(
  "AR AU AT BE BR CA CL DK FI FR DE HK IN ID IT JP KR MY MX NL NZ NO CN PL " +
    "PT PH RU SA ZA ES SE CH TW TR GB US",
);

/** The languages Brave and You.com take as a plain two-letter code. */
export const BRAVE_LANGUAGES = codes(
  "ar eu bn bg ca hr cs da nl en et fi fr gl de el gu he hi hu is it ja kn " +
    "ko lv lt ms ml mr nb pl pa ro ru sr sk sl es sv ta te th tr uk vi",
);

/** The languages Brave and You.com take only with a script or a region. */
export const BRAVE_LANGUAGE_VARIANTS: Readonly<Record<string, string>> = {
  zh: "zh-hans",
  pt: "pt-br",
  no: "nb",
};

/** The countries Google searches for (`gl`), which Serper, SerpAPI and Jina pass on. */
export const GOOGLE_COUNTRIES = codes(
  "AF AL DZ AS AD AO AI AQ AG AR AM AW AU AT AZ BS BH BD BB BY BE BZ BJ BM " +
    "BT BO BA BW BV BR IO BN BG BF BI KH CM CA CV KY CF TD CL CN CX CC CO KM " +
    "CG CD CK CR CI HR CU CY CZ DK DJ DM DO EC EG SV GQ ER EE ET FK FO FJ FI " +
    "FR GF PF TF GA GM GE DE GH GI GR GL GD GP GU GT GG GN GW GY HT HM VA HN " +
    "HK HU IS IN ID IR IQ IE IM IL IT JE JM JP JO KZ KE KI KP KR KW KG LA LV " +
    "LB LS LR LY LI LT LU MO MK MG MW MY MV ML MT MH MQ MR MU YT MX FM MD MC " +
    "MN ME MS MA MZ MM NA NR NP NL AN NC NZ NI NE NG NU NF MP NO OM PK PW PS " +
    "PA PG PY PE PH PN PL PT PR QA RE RO RU RW SH KN LC PM VC WS SM ST SA SN " +
    "RS SC SL SG SK SI SB SO ZA GS ES LK SD SR SJ SZ SE CH SY TW TJ TZ TH TL " +
    "TG TK TO TT TN TR TM TC TV UG UA AE UK GB US UM UY UZ VU VE VN VG VI WF " +
    "EH YE ZM ZW",
);

/** The languages Google takes as a two-letter code (`hl`). */
export const GOOGLE_LANGUAGES = codes(
  "af ak sq ws am ar hy az eu be bn bh bs br bg bt km ca ny co hr cs da nl " +
    "en eo et ee fo tl fi fr fy gl ka de el kl gn gu ht ha iw he hi hu is ig " +
    "id ia ga it ja jw kn kk rw rn kg ko ku ky lo la lv ln lt lg mk mg ms ml " +
    "mt mv mi mr mo mn my ne no nn oc or om ps fa pl pt pa qu ro rm ru gd sr " +
    "sh st tn sn sd si sk sl so es su sw sv tg ta tt te th ti to tr tk tw ug " +
    "uk ur uz vu vi cy wo xh yi yo zu",
);

/** The languages Google takes only with a region. */
export const GOOGLE_LANGUAGE_VARIANTS: Readonly<Record<string, string>> = {
  zh: "zh-cn",
};

/** Tavily names a country in English, in lower case. These are the names it lists, by country code. */
export const TAVILY_COUNTRIES: Readonly<Record<string, string>> = {
  AD: "andorra",
  AE: "united arab emirates",
  AF: "afghanistan",
  AL: "albania",
  AM: "armenia",
  AO: "angola",
  AR: "argentina",
  AT: "austria",
  AU: "australia",
  AZ: "azerbaijan",
  BA: "bosnia and herzegovina",
  BB: "barbados",
  BD: "bangladesh",
  BE: "belgium",
  BF: "burkina faso",
  BG: "bulgaria",
  BH: "bahrain",
  BI: "burundi",
  BJ: "benin",
  BN: "brunei",
  BO: "bolivia",
  BR: "brazil",
  BS: "bahamas",
  BT: "bhutan",
  BW: "botswana",
  BY: "belarus",
  BZ: "belize",
  CA: "canada",
  CF: "central african republic",
  CG: "congo",
  CH: "switzerland",
  CL: "chile",
  CM: "cameroon",
  CN: "china",
  CO: "colombia",
  CR: "costa rica",
  CU: "cuba",
  CV: "cape verde",
  CY: "cyprus",
  CZ: "czech republic",
  DE: "germany",
  DJ: "djibouti",
  DK: "denmark",
  DO: "dominican republic",
  DZ: "algeria",
  EC: "ecuador",
  EE: "estonia",
  EG: "egypt",
  ER: "eritrea",
  ES: "spain",
  ET: "ethiopia",
  FI: "finland",
  FJ: "fiji",
  FR: "france",
  GA: "gabon",
  GB: "united kingdom",
  GE: "georgia",
  GH: "ghana",
  GM: "gambia",
  GN: "guinea",
  GQ: "equatorial guinea",
  GR: "greece",
  GT: "guatemala",
  HN: "honduras",
  HR: "croatia",
  HT: "haiti",
  HU: "hungary",
  ID: "indonesia",
  IE: "ireland",
  IL: "israel",
  IN: "india",
  IQ: "iraq",
  IR: "iran",
  IS: "iceland",
  IT: "italy",
  JM: "jamaica",
  JO: "jordan",
  JP: "japan",
  KE: "kenya",
  KG: "kyrgyzstan",
  KH: "cambodia",
  KM: "comoros",
  KP: "north korea",
  KR: "south korea",
  KW: "kuwait",
  KZ: "kazakhstan",
  LB: "lebanon",
  LI: "liechtenstein",
  LK: "sri lanka",
  LR: "liberia",
  LS: "lesotho",
  LT: "lithuania",
  LU: "luxembourg",
  LV: "latvia",
  LY: "libya",
  MA: "morocco",
  MC: "monaco",
  MD: "moldova",
  ME: "montenegro",
  MG: "madagascar",
  MK: "north macedonia",
  ML: "mali",
  MM: "myanmar",
  MN: "mongolia",
  MR: "mauritania",
  MT: "malta",
  MU: "mauritius",
  MV: "maldives",
  MW: "malawi",
  MX: "mexico",
  MY: "malaysia",
  MZ: "mozambique",
  NA: "namibia",
  NE: "niger",
  NG: "nigeria",
  NI: "nicaragua",
  NL: "netherlands",
  NO: "norway",
  NP: "nepal",
  NZ: "new zealand",
  OM: "oman",
  PA: "panama",
  PE: "peru",
  PG: "papua new guinea",
  PH: "philippines",
  PK: "pakistan",
  PL: "poland",
  PT: "portugal",
  PY: "paraguay",
  QA: "qatar",
  RO: "romania",
  RS: "serbia",
  RU: "russia",
  RW: "rwanda",
  SA: "saudi arabia",
  SD: "sudan",
  SE: "sweden",
  SG: "singapore",
  SI: "slovenia",
  SK: "slovakia",
  SN: "senegal",
  SO: "somalia",
  SS: "south sudan",
  SV: "el salvador",
  SY: "syria",
  TD: "chad",
  TG: "togo",
  TH: "thailand",
  TJ: "tajikistan",
  TM: "turkmenistan",
  TN: "tunisia",
  TR: "turkey",
  TT: "trinidad and tobago",
  TW: "taiwan",
  TZ: "tanzania",
  UA: "ukraine",
  UG: "uganda",
  US: "united states",
  UY: "uruguay",
  UZ: "uzbekistan",
  VE: "venezuela",
  VN: "vietnam",
  YE: "yemen",
  ZA: "south africa",
  ZM: "zambia",
  ZW: "zimbabwe",
};
