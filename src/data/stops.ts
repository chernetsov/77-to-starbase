// Content for the 01 · Ground track stop cards. Ids match route.json stops (plus the Starbase recon stop).
// Photos live in public/images/stops/<file>.{webp,jpg}, 800×533, metadata stripped.

export interface StopPhoto {
  file: string;
  alt: string;
  author: string;
  license: string;
  licenseUrl?: string;
  source: string;
}

export interface Stop {
  id: string;
  name: string;
  kicker: string;
  blurb: string;
  facts: [string, string][];
  photos: StopPhoto[];
}

const BY = 'https://creativecommons.org/licenses/by';
const BY_SA = 'https://creativecommons.org/licenses/by-sa';
const commons = (file: string) => `https://commons.wikimedia.org/wiki/File:${file}`;

export const stops: Stop[] = [
  {
    id: 'austin',
    name: 'Austin',
    kicker: 'Pickup · barbecue · boots',
    blurb:
      'Wheels down at AUS, bags in the frunk, and we roll. The state capital: live music, Lady Bird Lake, and a bridge full of bats.',
    facts: [
      ['Bats', 'About 1.5 million free-tailed bats leave the Congress Avenue Bridge at dusk, March to October.'],
      ['Boots', 'Allens Boots on South Congress. Try on a pair. Then try not to buy them.'],
    ],
    photos: [
      {
        file: 'austin-1',
        alt: 'Downtown Austin towers rising above Lady Bird Lake on a clear day',
        author: 'ajay_suresh',
        license: 'CC BY 4.0',
        licenseUrl: `${BY}/4.0/`,
        source: commons('Downtown_Austin_Skyline_-_Lady_Bird_Lake_(54987239041).jpg'),
      },
      {
        file: 'austin-2',
        alt: 'People lining the Congress Avenue Bridge railing at dusk, waiting for the bats',
        author: 'Aleksandr Zykov',
        license: 'CC BY-SA 2.0',
        licenseUrl: `${BY_SA}/2.0/`,
        source: commons('Congress_Avenue_Bridge_Bats_(8095564615).jpg'),
      },
    ],
  },
  {
    id: 'lockhart',
    name: 'Lockhart',
    kicker: 'Barbecue capital of Texas',
    blurb:
      'Thirty minutes out of town and it smells like post oak. Brisket for breakfast is allowed here. Encouraged, even.',
    facts: [
      ['Official', 'The Texas Legislature named Lockhart the Barbecue Capital of Texas in 1999.'],
      ['House rules', 'Meat by the pound on butcher paper. Kreuz Market made its name on no sauce and no forks.'],
    ],
    photos: [
      {
        file: 'lockhart-1',
        alt: 'A wood fire burning at the mouth of a brick barbecue pit at Smitty’s Market',
        author: 'Neil Aitkenhead',
        license: 'CC BY-SA 3.0',
        licenseUrl: `${BY_SA}/3.0/`,
        source: commons("Pits_in_Smitty's_Market_-_panoramio.jpg"),
      },
      {
        file: 'lockhart-2',
        alt: 'A pitmaster in an apron slicing brisket at Smitty’s Market',
        author: 'Neil Aitkenhead',
        license: 'CC BY-SA 3.0',
        licenseUrl: `${BY_SA}/3.0/`,
        source: commons('Brisket_Looks_Great_-_Tastes_Even_Better_-_panoramio.jpg'),
      },
      {
        file: 'lockhart-3',
        alt: 'The long timber-beamed dining hall at Kreuz Market',
        author: 'Dameon Hudson',
        license: 'CC BY 3.0',
        licenseUrl: `${BY}/3.0/`,
        source: commons('Kreuz_market_-_panoramio.jpg'),
      },
    ],
  },
  {
    id: 'luling',
    name: 'Luling Buc-ee’s',
    kicker: 'Fuel, jerky, beaver',
    blurb:
      'A gas station the size of a supermarket, with a cartoon beaver on everything. Fill the tank, fill the bags. The ranch country further south is long and empty.',
    facts: [
      ['Order', 'Chopped brisket sandwich from the counter in the middle, a bag of Beaver Nuggets, a wall of jerky.'],
      ['Famous for', 'The restrooms. Seriously. Texans will tell you about them unprompted.'],
    ],
    photos: [
      {
        file: 'luling-1',
        alt: 'The Buc-ee’s beaver sign on a pole against a bright blue sky in Luling',
        author: 'dave_stone',
        license: 'CC BY 2.0',
        licenseUrl: `${BY}/2.0/`,
        source: commons('Buc-ees_in_Luling,_Texas,_2008_-_07.jpg'),
      },
      {
        file: 'luling-2',
        alt: 'Inside a Buc-ee’s: the barbecue counter under rows of ceiling lights',
        author: 'WhisperToMe',
        license: 'CC0',
        licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
        source: commons('Buceesinteriorbastrop.jpg'),
      },
    ],
  },
  {
    id: 'cuero',
    name: 'Cuero',
    kicker: 'Turkey capital of the world',
    blurb:
      'Small-town main street on the way to Victoria. Wave at the turkeys. Cuero takes them very seriously.',
    facts: [
      ['Turkeyfest', 'Every October since the 1970s, Cuero races a turkey against one from Worthington, Minnesota.'],
      ['Leg', '28 miles to Victoria and US-77.'],
    ],
    photos: [
      {
        file: 'cuero-1',
        alt: 'Brick storefronts and a dancehall saloon along Cuero’s historic main street',
        author: 'Renelibrary',
        license: 'CC BY-SA 3.0',
        licenseUrl: `${BY_SA}/3.0/`,
        source: commons('Cuero_Commercial_Historic_District2.JPG'),
      },
    ],
  },
  {
    id: 'victoria',
    name: 'Victoria',
    kicker: 'Join US-77 · Supercharger',
    blurb:
      'Plug in, stretch, grab a coffee. From here it is one road, mostly straight, all the way to the border.',
    facts: [
      ['Charge', 'Supercharger stop. Top up for the long run south: next big town is Kingsville, 113 miles on.'],
      ['Old courthouse', 'The 1892 county courthouse downtown: Romanesque limestone with a clock tower.'],
    ],
    photos: [
      {
        file: 'victoria-1',
        alt: 'The ornate stone 1892 Victoria County Courthouse with its clock tower',
        author: 'Renelibrary',
        license: 'CC BY-SA 4.0',
        licenseUrl: `${BY_SA}/4.0/`,
        source: commons('Victoria_County_Courthouse_2015.jpg'),
      },
    ],
  },
  {
    id: 'kingsville',
    name: 'Kingsville',
    kicker: 'King Ranch Saddle Shop',
    blurb:
      'Home of the King Ranch, which is bigger than Rhode Island. Real cowboys, the Running W brand, and leather that outlives you.',
    facts: [
      ['Since 1853', 'King Ranch covers about 825,000 acres. It bred the Santa Gertrudis, the first American beef breed.'],
      ['Shop', 'King Ranch Saddle Shop downtown: belts, bags and boots stamped with the Running W.'],
    ],
    photos: [
      {
        file: 'kingsville-1',
        alt: 'Two vaqueros in white hats on horseback under the Santa Gertrudis arches at King Ranch',
        author: 'Carol M. Highsmith',
        license: 'Public domain',
        source: commons(
          'Riders_at_the_King_Ranch,_which_is_larger_than_Rhode_Island,_near_Kingsville,_Texas_LCCN2011632496.tif',
        ),
      },
      {
        file: 'kingsville-2',
        alt: 'The white stucco King Ranch main house behind live oaks',
        author: 'Darryn Rose',
        license: 'CC BY-SA 4.0',
        licenseUrl: `${BY_SA}/4.0/`,
        source: commons('King_Ranch_Main_House_1.jpg'),
      },
    ],
  },
  {
    id: 'raymondville',
    name: 'Raymondville',
    kicker: 'Ranch country',
    blurb:
      'You just crossed Kenedy County: ranch land, mesquite, and almost nobody. Raymondville is where the towns start again.',
    facts: [
      ['Empty', 'Kenedy County has about 350 residents across 1,900 square miles. No services for a long stretch.'],
      ['Heads up', 'The Border Patrol checkpoint near Sarita is northbound only. Passport on you for the return.'],
    ],
    photos: [
      {
        file: 'raymondville-1',
        alt: 'The red-brick Willacy County Courthouse in Raymondville with flags out front',
        author: 'Larry D. Moore',
        license: 'CC BY 4.0',
        licenseUrl: `${BY}/4.0/`,
        source: commons('Willacy_courthouse.jpg'),
      },
    ],
  },
  {
    id: 'brownsville',
    name: 'Brownsville',
    kicker: 'End of the line · Hwy 4',
    blurb:
      'The southern tip of Texas, across the river from Matamoros. Golden hour, tacos, then east on Highway 4 toward the rockets.',
    facts: [
      ['Southernmost', 'The southernmost city in Texas. Mexico is a walk across the bridge.'],
      ['Turn', 'Highway 4 runs 20-odd miles east to Starbase and Boca Chica Beach. Check closures first.'],
    ],
    photos: [
      {
        file: 'brownsville-1',
        alt: 'A colorful street mural in downtown Brownsville with guitars, a flag and a courthouse',
        author: 'Carol M. Highsmith',
        license: 'Public domain',
        source: commons(
          'A_portion_of_a_colorful_street_mural_in_downtown_Brownsville,_Texas_LCCN2014630472.tif',
        ),
      },
      {
        file: 'brownsville-2',
        alt: 'The Stillman House Museum, a white 1850s brick house in Brownsville',
        author: 'Carol M. Highsmith',
        license: 'Public domain',
        source: commons(
          'The_Stillman_House_Museum,_among_the_oldest_surviving_structures_in_Brownsville,_Texas_LCCN2014630480.tif',
        ),
      },
    ],
  },
  {
    id: 'spi',
    name: 'South Padre Island',
    kicker: 'Hotel · beach · ceviche',
    blurb:
      'Over the causeway to a barrier island of sand and Gulf breeze. Launch morning we walk to Isla Blanca Park at the south tip and look across the pass.',
    facts: [
      ['Isla Blanca', 'About 5 miles across Brazos Santiago Pass to the pads. The roar lands roughly 25 seconds after liftoff.'],
      ['Causeway', 'The Queen Isabella Causeway, 2.4 miles long, the longest bridge in Texas.'],
    ],
    photos: [
      {
        file: 'spi-1',
        alt: 'Starship SN8 climbing on a column of smoke, seen across the water from South Padre Island',
        author: 'Forest Katsch',
        license: 'CC BY-SA 4.0',
        licenseUrl: `${BY_SA}/4.0/`,
        source: commons('SpaceX_Starship_SN8_launch_as_viewed_from_South_Padre_Island.jpg'),
      },
      {
        file: 'spi-2',
        alt: 'Wide sandy beach on South Padre Island with dunes and a boardwalk',
        author: 'Spheroidite',
        license: 'CC BY-SA 4.0',
        licenseUrl: `${BY_SA}/4.0/`,
        source: commons('South_Padre_Island_beach_panorama.jpg'),
      },
    ],
  },
  {
    id: 'starbase',
    name: 'Starbase',
    kicker: 'Launch site · recon day',
    blurb:
      'Highway 4 ends at the beach, and the last few miles run right past the rockets. Stainless steel, chopsticks, and a lot of Texas sky.',
    facts: [
      ['From Hwy 4', 'The Starfactory and the giant build bays first, then the launch tower by the dunes. Stay in the car near the pads.'],
      ['Closures', 'The road and Boca Chica Beach close for launches and tests. On launch day we watch from Isla Blanca.'],
    ],
    photos: [
      {
        file: 'starbase-1',
        alt: 'The Starbase launch towers and tank farm seen down Highway 4 past Boca Chica Beach',
        author: 'Alexander Hatley',
        license: 'CC BY 2.0',
        licenseUrl: `${BY}/2.0/`,
        source: commons('USA_-_Texas_-_Boca_Chica_-_Starbase_(51287483991).jpg'),
      },
      {
        file: 'starbase-2',
        alt: 'A STARBASE sign in front of the tall build bays',
        author: 'Jenny Hautmann',
        license: 'CC BY-SA 4.0',
        licenseUrl: `${BY_SA}/4.0/`,
        source: commons('Starbase.jpg'),
      },
    ],
  },
];
