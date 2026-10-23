/**
 * [DAT-01] Club names, cities and 3-letter codes for the 20 invented clubs (BRIEF §15), screened against real
 * football (BRIEF §2: no real clubs, leagues, players, kits, crests or stadiums).
 *
 * Generation-time only: tools/gen-data.ts uses this to build src/data/clubs.generated.ts, which is committed.
 * Nothing at runtime imports this file (src/data/clubs.ts reads the generated data), so the word lists and
 * denylists never reach the game bundle.
 *
 * Names are composed from word lists, never stored whole:
 *   PLACE_SUFFIX   "Saltmere Rovers"    place (head + tail joined) + a generic club suffix
 *   PLACE_APART    "Harbour Vale"       head and tail as two words (the club is just its place)
 *   PLACE_NICKNAME "Flintdale Comets"   place + a plural nickname
 *   EMBLEM_SUFFIX  "Kestrel Athletic"   a single emblem word + suffix; the city is a separate generated place
 *   FC_PLACE       "FC Ironholm"        prefix + place
 *
 * Screening (`screenClubName`, accent/case/punctuation-insensitive, keys from data/screen.ts `nameKey`):
 *   'full'      the name (or city) equals or contains a real club's full name ("Real Salt Lake", "West Ham");
 *   'token'     any word equals a real-club city/word, stadium or famous place ("Everton", "Anfield", "Leeds");
 *   'contains'  a word or the whole name contains such a token of 5+ letters ("Evertonmere"), or starts with a
 *               4-letter one ("Hullmere");
 *   'near'      a word is one edit from a token of 6+ letters ("Arsenel");
 *   'nickname'  a word is a famous club nickname ("Wolves", "Magpies"), singular or plural;
 *   'offensive' the name contains an offensive fragment (data/screen.ts OFFENSIVE_FRAGMENTS).
 * The rules run in that order; the first hit is reported.
 * Codes (`isCodeAllowed`) are three capital letters, never a real club's broadcast code, a national-team code or
 * an offensive abbreviation.
 */
import { OFFENSIVE_FRAGMENTS, nameKey, normalizeName, withinOneEdit } from './screen';

const LOCAL_TUNING = { // LOCAL_TUNING (non-gameplay: club-name generation; generation-time only: re-run `npm run gen:data` after a change)
  /** Longest club name / city, characters (menus and the team-select carousel). */
  maxNameLength: 20,
  maxCityLength: 14,
  /** Times one suffix (Rovers, United ...) / one place tail (-mere, Vale ...) may appear in a league. */
  maxSuffixUses: 2,
  maxTailUses: 1,
  /** Candidate draws per club before generation fails loudly. */
  maxAttempts: 4000,
} as const;

// ---------------------------------------------------------------- word lists

/** First half of a place name. Joined with a tail when the result has at most PLACE_JOIN_MAX letters. */
export const PLACE_HEADS: readonly string[] = [
  'Alder', 'Amber', 'Aspen', 'Birch', 'Bracken', 'Briar', 'Bright', 'Cedar', 'Cinder', 'Clay', 'Copper', 'Coral',
  'Crane', 'Elder', 'Ember', 'Fern', 'Flint', 'Frost', 'Gale', 'Garnet', 'Glass', 'Gold', 'Granite', 'Harbour',
  'Hazel', 'Heather', 'Holly', 'Iron', 'Ivy', 'Juniper', 'Kestrel', 'Lark', 'Linden', 'Marble', 'Meadow', 'Mist',
  'Moss', 'Oak', 'Ochre', 'Onyx', 'Otter', 'Pebble', 'Pine', 'Quarry', 'Raven', 'Reed', 'Rook', 'Rowan', 'Saffron',
  'Sage', 'Salt', 'Sand', 'Silver', 'Slate', 'Sorrel', 'Starling', 'Stone', 'Storm', 'Swift', 'Tallow', 'Thorn',
  'Tide', 'Umber', 'Willow', 'Wren', 'Yarrow',
];

export interface PlaceTail {
  word: string;
  /** May be joined to a head ("Salt" + "mere" = "Saltmere"). */
  join: boolean;
  /** May stand as its own word ("Harbour Vale"). */
  apart: boolean;
}

/** Second half of a place name. */
export const PLACE_TAILS: readonly PlaceTail[] = [
  { word: 'vale', join: true, apart: true }, { word: 'mere', join: true, apart: true },
  { word: 'haven', join: true, apart: true }, { word: 'gate', join: true, apart: true },
  { word: 'moor', join: true, apart: true }, { word: 'ridge', join: true, apart: true },
  { word: 'dale', join: true, apart: true }, { word: 'brook', join: true, apart: true },
  { word: 'crest', join: true, apart: true }, { word: 'fell', join: true, apart: true },
  { word: 'heath', join: true, apart: true }, { word: 'marsh', join: true, apart: true },
  { word: 'shore', join: true, apart: true }, { word: 'holt', join: true, apart: true },
  { word: 'cliff', join: true, apart: true }, { word: 'mead', join: true, apart: false },
  { word: 'wick', join: true, apart: false }, { word: 'holm', join: true, apart: false },
  { word: 'stead', join: true, apart: false }, { word: 'field', join: true, apart: false },
  { word: 'combe', join: true, apart: false }, { word: 'garth', join: true, apart: false },
  { word: 'hythe', join: true, apart: false }, { word: 'wold', join: true, apart: false },
  { word: 'thwaite', join: true, apart: false }, { word: 'keld', join: true, apart: false },
  { word: 'hollow', join: false, apart: true }, { word: 'reach', join: false, apart: true },
  { word: 'cross', join: false, apart: true }, { word: 'point', join: false, apart: true },
  { word: 'bay', join: false, apart: true }, { word: 'falls', join: false, apart: true },
  { word: 'rise', join: false, apart: true }, { word: 'tor', join: false, apart: true },
];

/** Longest joined place word, letters. */
export const PLACE_JOIN_MAX = 10;

/** Generic club suffixes (none identifies a real club on its own). */
export const CLUB_SUFFIXES: readonly string[] = [
  'Athletic', 'Rovers', 'Wanderers', 'Town', 'United', 'City', 'Albion', 'Harriers', 'County', 'Rangers', 'Borough',
  'FC',
];

/** Prefixes for FC_PLACE names. */
export const CLUB_PREFIXES: readonly string[] = ['FC', 'AFC'];

/** Plural nicknames for PLACE_NICKNAME names (none is a famous club nickname, see FAMOUS_NICKNAMES). */
export const CLUB_NICKNAMES: readonly string[] = [
  'Comets', 'Lanterns', 'Beacons', 'Anchors', 'Meteors', 'Sparks', 'Voyagers', 'Jackdaws', 'Badgers', 'Curlews',
  'Kites', 'Puffins', 'Stoats', 'Hares', 'Lapwings', 'Otters',
];

/** Single emblem words for EMBLEM_SUFFIX names ("Kestrel Athletic"). */
export const EMBLEM_WORDS: readonly string[] = [
  'Kestrel', 'Comet', 'Lantern', 'Anchor', 'Meteor', 'Falcon', 'Cobalt', 'Granite', 'Summit', 'Curlew', 'Sparrow',
  'Tempest', 'Orbit', 'Quartz', 'Lapwing', 'Cascade', 'Jackdaw',
];

// ---------------------------------------------------------------- denylists

/** Well-known real clubs, full names (the screen also rejects names that contain one). */
export const REAL_CLUB_NAMES: readonly string[] = [
  // England
  'Arsenal', 'Aston Villa', 'Bournemouth', 'Brentford', 'Brighton and Hove Albion', 'Burnley', 'Chelsea',
  'Crystal Palace', 'Everton', 'Fulham', 'Ipswich Town', 'Leicester City', 'Liverpool', 'Luton Town',
  'Manchester City', 'Manchester United', 'Newcastle United', 'Nottingham Forest', 'Sheffield United',
  'Southampton', 'Tottenham Hotspur', 'West Ham United', 'Wolverhampton Wanderers', 'Birmingham City',
  'Blackburn Rovers', 'Bristol City', 'Bristol Rovers', 'Cardiff City', 'Coventry City', 'Derby County', 'Hull City',
  'Leeds United', 'Middlesbrough', 'Millwall', 'Norwich City', 'Oxford United', 'Plymouth Argyle', 'Portsmouth',
  'Preston North End', 'Queens Park Rangers', 'Sheffield Wednesday', 'Stoke City', 'Sunderland', 'Swansea City',
  'Watford', 'West Bromwich Albion', 'Barnsley', 'Blackpool', 'Bolton Wanderers', 'Bradford City', 'Burton Albion',
  'Cambridge United', 'Charlton Athletic', 'Cheltenham Town', 'Chesterfield', 'Colchester United', 'Crawley Town',
  'Crewe Alexandra', 'Doncaster Rovers', 'Exeter City', 'Fleetwood Town', 'Forest Green Rovers', 'Gillingham',
  'Grimsby Town', 'Harrogate Town', 'Huddersfield Town', 'Lincoln City', 'Mansfield Town', 'Morecambe',
  'Northampton Town', 'Notts County', 'Oldham Athletic', 'Peterborough United', 'Port Vale', 'Reading',
  'Rotherham United', 'Salford City', 'Shrewsbury Town', 'Stevenage', 'Stockport County', 'Swindon Town',
  'Tranmere Rovers', 'Walsall', 'Wigan Athletic', 'AFC Wimbledon', 'Wimbledon', 'Wrexham', 'Wycombe Wanderers',
  'Accrington Stanley', 'Barrow', 'Bromley', 'Carlisle United', 'Leyton Orient', 'Milton Keynes Dons',
  'Newport County', 'Scunthorpe United', 'Southend United', 'Sutton United', 'Torquay United', 'Yeovil Town',
  'Hartlepool United', 'FC Halifax Town', 'York City', 'Macclesfield Town', 'Bury', 'Rochdale', 'Hereford United',
  'Kidderminster Harriers', 'Dagenham and Redbridge', 'Aldershot Town', 'Boreham Wood', 'Solihull Moors',
  'Gateshead', 'Chester', 'Maidstone United', 'Woking', 'Eastleigh', 'Wealdstone', 'Dorking Wanderers',
  'Corinthian Casuals', 'Sheffield FC', 'Barnet', 'Altrincham', 'Southport', 'Chorley', 'Ebbsfleet United',
  'Dartford', 'Tamworth', 'Kettering Town', 'AFC Telford United', 'Weymouth', 'Boston United', 'Oxford City',
  // Scotland, Wales, Ireland
  'Celtic', 'Rangers', 'Aberdeen', 'Heart of Midlothian', 'Hibernian', 'Dundee', 'Dundee United', 'Motherwell',
  'Kilmarnock', 'St Johnstone', 'St Mirren', 'Ross County', 'Livingston', 'Inverness Caledonian Thistle',
  'Partick Thistle', 'Hamilton Academical', 'Falkirk', 'Dunfermline Athletic', 'Raith Rovers', 'Airdrieonians',
  'Ayr United', 'Queen of the South', 'Greenock Morton', 'Arbroath', 'Queens Park', 'Stirling Albion',
  'Berwick Rangers', 'The New Saints', 'Shamrock Rovers', 'Bohemians', 'Shelbourne', 'Derry City', 'Dundalk',
  'Linfield', 'Glentoran', 'Cliftonville', 'St Patricks Athletic', 'Sligo Rovers', 'Bray Wanderers',
  // Spain, Germany, Italy, France
  'Real Madrid', 'Barcelona', 'Atletico Madrid', 'Sevilla', 'Valencia', 'Villarreal', 'Real Sociedad',
  'Athletic Bilbao', 'Athletic Club', 'Real Betis', 'Celta Vigo', 'Espanyol', 'Getafe', 'Osasuna', 'Mallorca',
  'Girona', 'Rayo Vallecano', 'Deportivo La Coruna', 'Real Zaragoza', 'Las Palmas', 'Real Valladolid',
  'Real Oviedo', 'Sporting Gijon', 'Bayern Munich', 'Borussia Dortmund', 'Borussia Monchengladbach', 'RB Leipzig',
  'Bayer Leverkusen', 'Schalke', 'Werder Bremen', 'Hamburger SV', 'VfB Stuttgart', 'Eintracht Frankfurt',
  'VfL Wolfsburg', 'Hoffenheim', 'Union Berlin', 'Hertha Berlin', 'FC Koln', 'SC Freiburg', 'Mainz',
  'FC Augsburg', 'VfL Bochum', 'St Pauli', 'Kaiserslautern', 'Nurnberg', 'Fortuna Dusseldorf', 'Hannover',
  'Juventus', 'Inter Milan', 'Internazionale', 'AC Milan', 'Napoli', 'Roma', 'Lazio', 'Atalanta', 'Fiorentina',
  'Torino', 'Bologna', 'Udinese', 'Sampdoria', 'Genoa', 'Parma', 'Sassuolo', 'Hellas Verona', 'Cagliari', 'Lecce',
  'Empoli', 'Monza', 'Salernitana', 'Spezia', 'Cremonese', 'Venezia', 'Como', 'Palermo', 'Brescia',
  'Paris Saint-Germain', 'Olympique de Marseille', 'Olympique Lyonnais', 'Monaco', 'Lille', 'OGC Nice',
  'Stade Rennais', 'RC Lens', 'Nantes', 'Girondins de Bordeaux', 'Saint-Etienne', 'Strasbourg', 'Montpellier',
  'Toulouse', 'Stade de Reims', 'Stade Brestois', 'Le Havre', 'Auxerre', 'Lorient', 'Angers',
  // Rest of Europe
  'Ajax', 'PSV Eindhoven', 'Feyenoord', 'AZ Alkmaar', 'FC Twente', 'FC Utrecht', 'Vitesse', 'Heerenveen',
  'Benfica', 'FC Porto', 'Sporting CP', 'Sporting Lisbon', 'Sporting Braga', 'Vitoria Guimaraes', 'Boavista',
  'Anderlecht', 'Club Brugge', 'Genk', 'Standard Liege', 'Royal Antwerp', 'Gent', 'Galatasaray', 'Fenerbahce',
  'Besiktas', 'Trabzonspor', 'Olympiacos', 'Panathinaikos', 'AEK Athens', 'PAOK', 'Red Star Belgrade', 'Partizan',
  'Dinamo Zagreb', 'Hajduk Split', 'Sparta Prague', 'Slavia Prague', 'Viktoria Plzen', 'Legia Warsaw',
  'Ferencvaros', 'Steaua Bucharest', 'Dynamo Kyiv', 'Shakhtar Donetsk', 'Zenit', 'Spartak Moscow', 'CSKA Moscow',
  'Lokomotiv Moscow', 'Basel', 'Young Boys', 'Grasshoppers', 'Red Bull Salzburg', 'Rapid Vienna', 'Austria Vienna',
  'Sturm Graz', 'FC Copenhagen', 'Brondby', 'Malmo', 'AIK', 'Djurgarden', 'Rosenborg', 'Molde', 'Bodo Glimt',
  'HJK Helsinki', 'Maccabi Tel Aviv', 'Maccabi Haifa', 'APOEL', 'Red Bull Leipzig',
  // Americas
  'Boca Juniors', 'River Plate', 'Independiente', 'Racing Club', 'San Lorenzo', 'Estudiantes', 'Velez Sarsfield',
  'Newells Old Boys', 'Rosario Central', 'Flamengo', 'Fluminense', 'Botafogo', 'Vasco da Gama', 'Corinthians',
  'Palmeiras', 'Sao Paulo', 'Santos', 'Gremio', 'Internacional', 'Cruzeiro', 'Atletico Mineiro', 'Penarol',
  'Nacional', 'Colo-Colo', 'Universidad de Chile', 'Club America', 'Chivas Guadalajara', 'Cruz Azul', 'Pumas',
  'Monterrey', 'Tigres', 'Toluca', 'Olimpia', 'LDU Quito', 'Alianza Lima', 'Universitario', 'Millonarios',
  'Atletico Nacional', 'LA Galaxy', 'Los Angeles FC', 'Seattle Sounders', 'Portland Timbers', 'Inter Miami',
  'Atlanta United', 'New York Red Bulls', 'New York City', 'Toronto FC', 'Vancouver Whitecaps', 'CF Montreal',
  'Columbus Crew', 'Chicago Fire', 'DC United', 'Sporting Kansas City', 'Real Salt Lake', 'Houston Dynamo',
  'FC Dallas', 'Colorado Rapids', 'San Jose Earthquakes', 'Minnesota United', 'Orlando City', 'Philadelphia Union',
  'New England Revolution', 'Nashville SC', 'Austin FC', 'FC Cincinnati', 'Charlotte FC', 'St Louis City',
  'New York Cosmos',
  // Africa, Asia, Oceania
  'Al Ahly', 'Zamalek', 'Al Hilal', 'Al Nassr', 'Al Ittihad', 'Kaizer Chiefs', 'Orlando Pirates',
  'Mamelodi Sundowns', 'Esperance', 'Raja Casablanca', 'Wydad', 'TP Mazembe', 'Enyimba', 'Asante Kotoko',
  'Hearts of Oak', 'Urawa Red Diamonds', 'Kashima Antlers', 'Yokohama F Marinos', 'Kawasaki Frontale',
  'Jeonbuk Hyundai Motors', 'Ulsan Hyundai', 'Pohang Steelers', 'Guangzhou Evergrande', 'Shanghai Port',
  'Melbourne Victory', 'Melbourne City', 'Sydney FC', 'Western Sydney Wanderers', 'Brisbane Roar',
  'Wellington Phoenix', 'Auckland City',
  // SGN-05 extension: second tiers, smaller leagues, fictional clubs from games, TV and comics
  'Stalybridge Celtic', 'Dulwich Hamlet', 'Bath City', 'Hayes and Yeading', 'Montrose', 'Forfar Athletic',
  'Brechin City', 'Cowdenbeath', 'East Fife', 'Alloa Athletic', 'Clyde', 'Stenhousemuir', 'Peterhead', 'Elgin City',
  'Annan Athletic', 'Stranraer', 'Albion Rovers', 'Dumbarton', 'Edinburgh City', 'Kelty Hearts', 'Bonnyrigg Rose',
  'Connahs Quay Nomads', 'Bala Town', 'Bangor City', 'Barry Town', 'Merthyr Tydfil', 'Caernarfon Town',
  'Aberystwyth Town', 'Haverfordwest County', 'Cork City', 'Galway United', 'Waterford', 'Drogheda United',
  'Finn Harps', 'Longford Town', 'Crusaders', 'Coleraine', 'Larne', 'Ballymena United', 'Portadown', 'Glenavon',
  'Eibar', 'Leganes', 'Alaves', 'Cadiz', 'Granada', 'Almeria', 'Elche', 'Levante', 'Malaga', 'Racing Santander',
  'Tenerife', 'Huesca', 'Mirandes', 'Albacete', 'Burgos', 'Cartagena', 'Castellon', 'Cordoba', 'Eldense',
  'Racing Ferrol', 'Numancia', 'Hercules', 'Recreativo Huelva', 'Ponferradina', 'Lugo', 'Holstein Kiel', 'Heidenheim',
  'Darmstadt', 'Paderborn', 'Greuther Furth', 'Karlsruher SC', 'Hansa Rostock', 'Dynamo Dresden', 'Arminia Bielefeld',
  'Energie Cottbus', 'MSV Duisburg', '1860 Munich', 'Magdeburg', 'Eintracht Braunschweig', 'Elversberg',
  'Preussen Munster', 'Sandhausen', 'Jahn Regensburg', 'Ingolstadt', 'Erzgebirge Aue', 'Carl Zeiss Jena',
  'Alemannia Aachen', 'Rot-Weiss Essen', 'Wehen Wiesbaden', 'Osnabruck', 'Kickers Offenbach', 'Frosinone', 'Pisa',
  'Bari', 'Catania', 'Pescara', 'Perugia', 'Reggina', 'Chievo', 'Ascoli', 'Modena', 'Reggiana', 'Cesena', 'Carrarese',
  'Cittadella', 'Ternana', 'Avellino', 'Vicenza', 'Padova', 'Triestina', 'Livorno', 'Foggia', 'Benevento', 'Crotone',
  'Juve Stabia', 'Pro Vercelli', 'Novara', 'Paris FC', 'Metz', 'Caen', 'Guingamp', 'Sochaux', 'Bastia', 'Ajaccio',
  'Troyes', 'Grenoble', 'Amiens', 'Dijon', 'Clermont', 'Laval', 'Rodez', 'Valenciennes', 'Nancy', 'Red Star',
  'Le Mans', 'Annecy', 'Dunkerque', 'Niort', 'Groningen', 'NEC Nijmegen', 'Sparta Rotterdam', 'Go Ahead Eagles',
  'Heracles Almelo', 'PEC Zwolle', 'Fortuna Sittard', 'Willem II', 'NAC Breda', 'RKC Waalwijk', 'Almere City',
  'Excelsior', 'ADO Den Haag', 'Roda JC', 'Volendam', 'Gil Vicente', 'Moreirense', 'Estoril', 'Famalicao', 'Arouca',
  'Casa Pia', 'Rio Ave', 'Santa Clara', 'Tondela', 'Maritimo', 'Vitoria Setubal', 'Belenenses', 'Farense',
  'Portimonense', 'Chaves', 'Hammarby', 'IFK Goteborg', 'Hacken', 'Elfsborg', 'Norrkoping', 'Viking', 'Brann',
  'Valerenga', 'Lillestrom', 'Midtjylland', 'Nordsjaelland', 'Aarhus', 'Aalborg', 'Odense', 'Silkeborg', 'Randers',
  'Lugano', 'Servette', 'Lausanne', 'St Gallen', 'FC Zurich', 'Luzern', 'Sion', 'LASK', 'Slovan Bratislava',
  'Ludogorets', 'CSKA Sofia', 'Levski Sofia', 'Qarabag', 'Sheriff Tiraspol', 'Maribor', 'Olimpija Ljubljana',
  'Rijeka', 'Osijek', 'Vojvodina', 'Lech Poznan', 'Rakow', 'Wisla Krakow', 'Gornik Zabrze', 'CFR Cluj', 'FCSB',
  'Dnipro', 'Krasnodar', 'Rubin Kazan', 'Hapoel Tel Aviv', 'Omonia', 'Union Saint-Gilloise', 'Cercle Brugge',
  'Mechelen', 'Charleroi', 'Lanus', 'Banfield', 'Huracan', 'Talleres', 'Belgrano', 'Godoy Cruz', 'Argentinos Juniors',
  'Athletico Paranaense', 'Bahia', 'Fortaleza', 'Ceara', 'Sport Recife', 'Coritiba', 'Goias', 'Bragantino',
  'Juventude', 'Mirassol', 'Chapecoense', 'Universidad Catolica', 'Barcelona SC', 'Emelec', 'Independiente del Valle',
  'Cerro Porteno', 'Bolivar', 'The Strongest', 'Sporting Cristal', 'Deportivo Cali', 'America de Cali',
  'Junior Barranquilla', 'Pachuca', 'Santos Laguna', 'Necaxa', 'Puebla', 'Queretaro', 'Saprissa', 'Alajuelense',
  'Herediano', 'San Diego FC', 'Sacramento Republic', 'Louisville City', 'Tampa Bay Rowdies', 'Detroit City',
  'Indy Eleven', 'Phoenix Rising', 'Oakland Roots', 'Hartford Athletic', 'Al Sadd', 'Al Duhail', 'Al Ain',
  'Persepolis', 'Esteghlal', 'Sepahan', 'Al Shabab', 'Al Qadsiah', 'Al Ettifaq', 'Buriram United',
  'Johor Darul Tazim', 'Beijing Guoan', 'Shandong Taishan', 'Shanghai Shenhua', 'Gamba Osaka', 'Cerezo Osaka',
  'Vissel Kobe', 'Nagoya Grampus', 'Sanfrecce Hiroshima', 'FC Tokyo', 'Kashiwa Reysol', 'Jubilo Iwata', 'FC Seoul',
  'Suwon Samsung Bluewings', 'Mohun Bagan', 'East Bengal', 'Kerala Blasters', 'Adelaide United', 'Perth Glory',
  'Central Coast Mariners', 'Newcastle Jets', 'Auckland FC', 'CR Belouizdad', 'JS Kabylie', 'ES Setif',
  'Club Africain', 'Etoile du Sahel', 'CS Sfaxien', 'Pyramids', 'Ismaily', 'Al Masry', 'Simba', 'Young Africans',
  'Petro de Luanda', 'Horoya', 'Canon Yaounde', 'Coton Sport', 'Rivers United', 'Gor Mahia', 'AFC Leopards',
  'Zesco United', 'Supersport United', 'Stellenbosch', 'Cape Town City', 'AmaZulu', 'Moroka Swallows',
  'Melchester Rovers', 'Harchester United', 'AFC Richmond', 'Earls Park', 'Barnstoneworth United', 'Piemonte Calcio',
  'Bergamo Calcio', 'Latium', 'Man Red', 'Merseyside Red', 'North London', 'London FC',
];

/**
 * Single words (or compact multi-word keys) that by themselves point at a real club: home towns and cities of
 * well-known clubs, distinctive club words, famous stadiums and a few famous places a word list could form.
 * Generic club words (United, City, Rovers, Athletic, Albion, Rangers, Vale ...) are deliberately absent.
 */
export const REAL_CLUB_TOKENS: readonly string[] = [
  // English and Welsh club towns
  'Arsenal', 'Aston', 'Bournemouth', 'Brentford', 'Brighton', 'Burnley', 'Chelsea', 'Everton', 'Fulham', 'Ipswich',
  'Leicester', 'Liverpool', 'Luton', 'Manchester', 'Newcastle', 'Nottingham', 'Sheffield', 'Southampton',
  'Tottenham', 'Hotspur', 'Spurs', 'West Ham', 'Wolverhampton', 'Birmingham', 'Blackburn', 'Bristol', 'Cardiff',
  'Coventry', 'Derby', 'Hull', 'Leeds', 'Middlesbrough', 'Millwall', 'Norwich', 'Oxford', 'Plymouth', 'Argyle',
  'Portsmouth', 'Preston', 'Swansea', 'Watford', 'Bromwich', 'Barnsley', 'Blackpool', 'Bolton', 'Bradford', 'Burton',
  'Cambridge', 'Charlton', 'Cheltenham', 'Chesterfield', 'Colchester', 'Crawley', 'Crewe', 'Doncaster', 'Exeter',
  'Fleetwood', 'Gillingham', 'Grimsby', 'Harrogate', 'Huddersfield', 'Lincoln', 'Mansfield', 'Morecambe',
  'Northampton', 'Notts', 'Oldham', 'Peterborough', 'Reading', 'Rotherham', 'Salford', 'Shrewsbury', 'Stevenage',
  'Stockport', 'Stoke', 'Sunderland', 'Swindon', 'Tranmere', 'Walsall', 'Wigan', 'Wimbledon', 'Wrexham', 'Wycombe',
  'Accrington', 'Barrow', 'Bromley', 'Carlisle', 'Orient', 'Milton Keynes', 'Newport', 'Scunthorpe', 'Southend',
  'Sutton', 'Torquay', 'Yeovil', 'Hartlepool', 'Halifax', 'York', 'Macclesfield', 'Bury', 'Rochdale', 'Hereford',
  'Kidderminster', 'Dagenham', 'Aldershot', 'Solihull', 'Gateshead', 'Chester', 'Maidstone', 'Woking', 'Eastleigh',
  'Wealdstone', 'Dorking', 'Barnet', 'Altrincham', 'Southport', 'Chorley', 'Ebbsfleet', 'Dartford', 'Tamworth',
  'Kettering', 'Telford', 'Weymouth', 'Leyton', 'Keynes', 'Alexandra', 'Wednesday', 'Palace', 'Forest', 'Villa', 'Stanley', 'Dons', 'Corinthian',
  'Corinthians', 'Casuals',
  // Scotland and Ireland
  'Celtic', 'Aberdeen', 'Midlothian', 'Hibernian', 'Dundee', 'Motherwell', 'Kilmarnock', 'Johnstone', 'Mirren',
  'Ross', 'Livingston', 'Inverness', 'Caledonian', 'Partick', 'Thistle', 'Hamilton', 'Academical', 'Falkirk',
  'Dunfermline', 'Raith', 'Airdrie', 'Ayr', 'Greenock', 'Arbroath', 'Stirling', 'Berwick', 'Shamrock', 'Bohemians',
  'Shelbourne', 'Derry', 'Dundalk', 'Linfield', 'Glentoran', 'Cliftonville', 'Sligo',
  // Europe
  'Madrid', 'Barcelona', 'Atletico', 'Sevilla', 'Seville', 'Valencia', 'Villarreal', 'Sociedad', 'Bilbao', 'Betis',
  'Celta', 'Vigo', 'Espanyol', 'Getafe', 'Osasuna', 'Mallorca', 'Girona', 'Vallecano', 'Deportivo', 'Coruna',
  'Zaragoza', 'Valladolid', 'Oviedo', 'Gijon', 'Bayern', 'Munich', 'Borussia', 'Dortmund', 'Monchengladbach',
  'Gladbach', 'Leipzig', 'Leverkusen', 'Schalke', 'Werder', 'Bremen', 'Hamburg', 'Stuttgart', 'Eintracht',
  'Frankfurt', 'Wolfsburg', 'Hoffenheim', 'Hertha', 'Berlin', 'Koln', 'Cologne', 'Freiburg', 'Mainz', 'Augsburg',
  'Bochum', 'Pauli', 'Kaiserslautern', 'Nurnberg', 'Nuremberg', 'Dusseldorf', 'Hannover', 'Juventus', 'Turin',
  'Internazionale', 'Milan', 'Milano', 'Napoli', 'Naples', 'Roma', 'Lazio', 'Atalanta', 'Fiorentina', 'Florence',
  'Torino', 'Bologna', 'Udinese', 'Sampdoria', 'Genoa', 'Parma', 'Sassuolo', 'Verona', 'Cagliari', 'Lecce', 'Empoli',
  'Monza', 'Salernitana', 'Spezia', 'Cremonese', 'Venezia', 'Venice', 'Palermo', 'Brescia', 'Paris', 'Germain',
  'Marseille', 'Olympique', 'Lyon', 'Lyonnais', 'Monaco', 'Lille', 'Nice', 'Rennes', 'Rennais', 'Lens', 'Nantes',
  'Bordeaux', 'Girondins', 'Etienne', 'Strasbourg', 'Montpellier', 'Toulouse', 'Reims', 'Brest', 'Brestois', 'Havre',
  'Auxerre', 'Lorient', 'Angers', 'Ajax', 'Amsterdam', 'Eindhoven', 'Feyenoord', 'Rotterdam', 'Alkmaar', 'Twente',
  'Utrecht', 'Vitesse', 'Heerenveen', 'Benfica', 'Lisbon', 'Porto', 'Braga', 'Guimaraes', 'Boavista', 'Anderlecht',
  'Brugge', 'Bruges', 'Genk', 'Liege', 'Antwerp', 'Gent', 'Galatasaray', 'Fenerbahce', 'Besiktas', 'Trabzonspor',
  'Istanbul', 'Olympiacos', 'Piraeus', 'Panathinaikos', 'Athens', 'Thessaloniki', 'Belgrade', 'Partizan', 'Zagreb',
  'Hajduk', 'Split', 'Prague', 'Sparta', 'Slavia', 'Plzen', 'Legia', 'Warsaw', 'Ferencvaros', 'Budapest', 'Steaua',
  'Bucharest', 'Dynamo', 'Dinamo', 'Kyiv', 'Kiev', 'Shakhtar', 'Donetsk', 'Zenit', 'Spartak', 'Moscow', 'Lokomotiv',
  'Basel', 'Grasshoppers', 'Salzburg', 'Rapid', 'Vienna', 'Wien', 'Graz', 'Copenhagen', 'Brondby', 'Malmo',
  'Djurgarden', 'Stockholm', 'Gothenburg', 'Rosenborg', 'Molde', 'Glimt', 'Helsinki', 'Maccabi', 'Haifa', 'Apoel',
  // Americas
  'Boca', 'Juniors', 'River Plate', 'Independiente', 'Lorenzo', 'Estudiantes', 'Sarsfield', 'Newells', 'Rosario',
  'Flamengo', 'Fluminense', 'Botafogo', 'Vasco', 'Gama', 'Palmeiras', 'Sao Paulo', 'Santos', 'Gremio',
  'Internacional', 'Cruzeiro', 'Mineiro', 'Penarol', 'Colo', 'Guadalajara', 'Chivas', 'Cruz Azul', 'Pumas',
  'Monterrey', 'Tigres', 'Toluca', 'Olimpia', 'Quito', 'Alianza', 'Universitario', 'Millonarios', 'Galaxy',
  'Sounders', 'Seattle', 'Timbers', 'Portland', 'Miami', 'Atlanta', 'Toronto', 'Whitecaps', 'Vancouver', 'Montreal',
  'Columbus', 'Chicago', 'Kansas', 'Salt Lake', 'Houston', 'Dallas', 'Colorado', 'San Jose', 'Earthquakes',
  'Minnesota', 'Orlando', 'Philadelphia', 'Nashville', 'Austin', 'Cincinnati', 'Charlotte', 'Louis', 'Cosmos',
  'New York', 'Los Angeles',
  // Africa, Asia, Oceania
  'Ahly', 'Zamalek', 'Hilal', 'Nassr', 'Ittihad', 'Kaizer', 'Sundowns', 'Mamelodi', 'Esperance', 'Raja',
  'Casablanca', 'Wydad', 'Mazembe', 'Enyimba', 'Kotoko', 'Urawa', 'Kashima', 'Antlers', 'Yokohama', 'Marinos',
  'Kawasaki', 'Frontale', 'Jeonbuk', 'Ulsan', 'Pohang', 'Guangzhou', 'Evergrande', 'Shanghai', 'Melbourne',
  'Sydney', 'Brisbane', 'Wellington', 'Auckland',
  // Stadiums
  'Anfield', 'Wembley', 'Highbury', 'Goodison', 'Hawthorns', 'Trafford', 'Stamford', 'Elland', 'Molineux',
  'Selhurst', 'Bramall', 'Hillsborough', 'Deepdale', 'Fratton', 'Kenilworth', 'Turf Moor', 'Ewood', 'Craven Cottage',
  'Ibrox', 'Parkhead', 'Hampden', 'Tynecastle', 'Pittodrie', 'Bernabeu', 'Camp Nou', 'Mestalla', 'San Siro',
  'Maracana', 'Bombonera', 'Westfalen', 'Allianz', 'Stadium of Light', 'Ashton Gate', 'Priestfield',
  // Famous places a word list could form
  'Hollywood', 'Springfield', 'Silverstone', 'Stonehaven', 'Silverdale', 'Ferndale', 'Glendale', 'Rosedale',
  'Ambergate', 'Sandgate', 'Claygate', 'Goldcrest', 'Oakdale', 'Riverdale', 'Sherwood', 'Windsor', 'Westminster',
  // SGN-05 extension: towns of the clubs added to REAL_CLUB_NAMES, more stadiums, fictional clubs
  'Stalybridge', 'Dulwich', 'Yeading', 'Montrose', 'Forfar', 'Brechin', 'Cowdenbeath', 'Alloa', 'Clyde',
  'Stenhousemuir', 'Peterhead', 'Elgin', 'Annan', 'Stranraer', 'Coatbridge', 'Dumbarton', 'Edinburgh', 'Glasgow',
  'Kelty', 'Bonnyrigg', 'Connahs', 'Bangor', 'Merthyr', 'Tydfil', 'Caernarfon', 'Aberystwyth', 'Haverfordwest',
  'Galway', 'Waterford', 'Drogheda', 'Longford', 'Crusaders', 'Coleraine', 'Ballymena', 'Portadown', 'Glenavon',
  'Eibar', 'Leganes', 'Alaves', 'Cadiz', 'Granada', 'Almeria', 'Elche', 'Levante', 'Malaga', 'Santander', 'Tenerife',
  'Huesca', 'Mirandes', 'Albacete', 'Burgos', 'Cartagena', 'Castellon', 'Cordoba', 'Eldense', 'Ferrol', 'Numancia',
  'Huelva', 'Ponferradina', 'Holstein', 'Heidenheim', 'Darmstadt', 'Paderborn', 'Greuther', 'Karlsruhe', 'Karlsruher',
  'Rostock', 'Dresden', 'Bielefeld', 'Arminia', 'Cottbus', 'Duisburg', 'Magdeburg', 'Braunschweig', 'Elversberg',
  'Preussen', 'Munster', 'Sandhausen', 'Regensburg', 'Ingolstadt', 'Erzgebirge', 'Alemannia', 'Aachen', 'Wiesbaden',
  'Osnabruck', 'Offenbach', 'Frosinone', 'Catania', 'Pescara', 'Perugia', 'Reggina', 'Chievo', 'Ascoli', 'Modena',
  'Reggiana', 'Cesena', 'Carrarese', 'Cittadella', 'Ternana', 'Avellino', 'Vicenza', 'Padova', 'Triestina', 'Livorno',
  'Foggia', 'Benevento', 'Crotone', 'Stabia', 'Vercelli', 'Novara', 'Guingamp', 'Sochaux', 'Bastia', 'Ajaccio',
  'Troyes', 'Grenoble', 'Amiens', 'Dijon', 'Clermont', 'Valenciennes', 'Annecy', 'Dunkerque', 'Groningen', 'Nijmegen',
  'Almelo', 'Heracles', 'Zwolle', 'Sittard', 'Waalwijk', 'Almere', 'Excelsior', 'Volendam', 'Vicente', 'Moreirense',
  'Estoril', 'Famalicao', 'Arouca', 'Tondela', 'Maritimo', 'Setubal', 'Belenenses', 'Farense', 'Portimonense',
  'Hammarby', 'Goteborg', 'Hacken', 'Elfsborg', 'Norrkoping', 'Valerenga', 'Lillestrom', 'Midtjylland',
  'Nordsjaelland', 'Aarhus', 'Aalborg', 'Odense', 'Silkeborg', 'Randers', 'Lugano', 'Servette', 'Lausanne', 'Zurich',
  'Luzern', 'Bratislava', 'Ludogorets', 'Sofia', 'Levski', 'Qarabag', 'Tiraspol', 'Maribor', 'Olimpija', 'Ljubljana',
  'Rijeka', 'Osijek', 'Vojvodina', 'Poznan', 'Krakow', 'Zabrze', 'Dnipro', 'Krasnodar', 'Kazan', 'Hapoel', 'Omonia',
  'Gilloise', 'Mechelen', 'Charleroi', 'Banfield', 'Huracan', 'Talleres', 'Belgrano', 'Argentinos', 'Paranaense',
  'Fortaleza', 'Recife', 'Coritiba', 'Bragantino', 'Juventude', 'Mirassol', 'Chapecoense', 'Catolica', 'Emelec',
  'Porteno', 'Bolivar', 'Barranquilla', 'Pachuca', 'Necaxa', 'Puebla', 'Queretaro', 'Saprissa', 'Alajuelense',
  'Herediano', 'Sacramento', 'Louisville', 'Rowdies', 'Detroit', 'Oakland', 'Hartford', 'Duhail', 'Persepolis',
  'Esteghlal', 'Sepahan', 'Qadsiah', 'Ettifaq', 'Buriram', 'Johor', 'Guoan', 'Taishan', 'Shenhua', 'Cerezo', 'Vissel',
  'Grampus', 'Sanfrecce', 'Hiroshima', 'Kashiwa', 'Reysol', 'Jubilo', 'Suwon', 'Bluewings', 'Bagan', 'Kerala',
  'Blasters', 'Adelaide', 'Belouizdad', 'Kabylie', 'Setif', 'Africain', 'Sfaxien', 'Ismaily', 'Masry', 'Luanda',
  'Horoya', 'Yaounde', 'Mahia', 'Zesco', 'Supersport', 'Stellenbosch', 'Amazulu', 'Moroka', 'Melchester',
  'Harchester', 'Barnstoneworth', 'Piemonte', 'Latium', 'Merseyside', 'Old Trafford', 'Villa Park', 'St James Park',
  'Emirates', 'Etihad', 'Signal Iduna', 'Wanda', 'Metropolitano', 'Celtic Park', 'Hampden Park', 'Parc des Princes',
  'Velodrome', 'Delle Alpi', 'Olimpico', 'Maradona', 'Azteca', 'Monumental', 'Centenario', 'Soccer City', 'Luzhniki',
];

/** Famous club nicknames; no generated word may be one (singular or plural). */
export const FAMOUS_NICKNAMES: readonly string[] = [
  'Gunners', 'Toffees', 'Magpies', 'Foxes', 'Saints', 'Hammers', 'Irons', 'Wolves', 'Wolf', 'Blades', 'Owls', 'Canaries',
  'Seagulls', 'Eagles', 'Hornets', 'Bees', 'Cherries', 'Villans', 'Baggies', 'Potters', 'Tigers', 'Lions',
  'Citizens', 'Cityzens', 'Red Devils', 'Clarets', 'Swans', 'Bluebirds', 'Terriers', 'Rams', 'Robins', 'Cobblers',
  'Posh', 'Shrimpers', 'Gills', 'Pirates', 'Valiants', 'Addicks', 'Royals', 'Hatters', 'Trotters', 'Latics',
  'Mariners', 'Imps', 'Stags', 'Bhoys', 'Gers', 'Hibees', 'Jambos', 'Pars', 'Buddies', 'Accies', 'Dons', 'Tractor Boys',
  'Black Cats', 'Boro', 'Pompey', 'Lilywhites', 'Glaziers', 'Shakers', 'Tykes', 'Millers', 'Railwaymen', 'Seasiders',
  'Cottagers', 'Grecians', 'Pilgrims', 'Quakers', 'Gulls', 'Daggers', 'Chairboys', 'Cumbrians', 'Saddlers',
  'Chiefs', 'Galacticos', 'Colchoneros', 'Blaugrana', 'Txuri-urdin', 'Rossoneri', 'Nerazzurri', 'Bianconeri',
  'Giallorossi', 'Biancocelesti', 'Viola', 'Partenopei', 'Les Parisiens', 'Les Canaris', 'Les Dogues', 'Die Roten',
  'Die Fohlen', 'Knappen', 'Werkself', 'Die Borussen', 'Boquenses', 'Millonarios', 'Gallinas', 'Verdao', 'Timao',
  'Mengao', 'Peixe', 'Herons', 'Sounders', 'Timbers', 'Whitecaps', 'Galaxy', 'Earthquakes', 'Rapids', 'Crew',
  'Red Bulls', 'Revolution', 'Fire', 'Union', 'Loons', 'Five Stripes', 'Lions', 'Bairns', 'Arabs', 'Sons',
  // SGN-05 extension
  'Bantams', 'Brewers', 'Dale', 'Exiles', 'Glovers', 'Iron', 'Minstermen', 'Monkey Hangers', 'Poppies', 'Sky Blues',
  'Spireites', 'Shots', 'Silkmen', 'Stanley', 'Throstles', "U's", 'Pensioners', 'Blues', 'Reds', 'Whites',
  'Cardinals', 'Bulls', 'Rossoblu', 'Granata', 'Grifone', 'Doriani', 'Aquile', 'Zebre', 'Vecchia Signora',
  'Merengues', 'Los Blancos', 'Che', 'Pericos', 'Txuri', 'Leones', 'Submarino', 'Rojiblancos', 'Bilbainos',
  'Verdiblancos', 'Die Wolfe', 'Geissbocke', 'Die Eisernen', 'Lowen', 'Les Verts', 'Les Girondins', 'Les Sang et Or',
  'Godenzonen', 'Lagartos', 'Dragoes', 'Aguias', 'Leoes', 'Tricolor', 'Xeneizes', 'Diablos Rojos', 'Pincha',
  'Canallas', 'Leprosos', 'Fortin', 'Urubu', 'Fogao', 'Furacao', 'Porco', 'Raposa', 'Galo', 'Colorado',
  'Tricolor Paulista', 'Charruas', 'Albos', 'Cementeros', 'Rayados', 'Diablos', 'Chivas', 'Pumas', 'Aguilas',
  'Kaizer Chiefs', 'Amakhosi', 'Buccaneers', 'Brazilians', 'Black Stars', 'Super Eagles', 'Pharaohs', 'Atlas Lions',
  'Desert Foxes', 'Elephants', 'Indomitable Lions', 'Socceroos', 'All Whites', 'Samurai Blue', 'Taeguk Warriors',
  'Three Lions', 'Oranje', 'Azzurri', 'Les Bleus', 'La Roja', 'Selecao', 'Albiceleste', 'Celeste', 'Vikings',
  'Tartan Army', 'Dragons', 'Boys in Green', 'Elf', 'Nati',
];

/**
 * Names from games, fiction, brands and famous places that the word lists could form (BRIEF §2: nothing from other
 * commercial games, no sponsors). One-word entries are screened like REAL_CLUB_TOKENS; multi-word entries also like
 * REAL_CLUB_NAMES ("Granite City" is caught although "City" is a generic suffix).
 */
export const FAMOUS_NAMES: readonly string[] = [
  // games
  'Stormgate', 'Frosthaven', 'Gloomhaven', 'Stormwind', 'Ironforge', 'Silvermoon', 'Goldshire', 'Ravenholm',
  'Ravenloft', 'Ravencrest', 'Ravenfield', 'Ravenshore', 'Whiterun', 'Riverwood', 'Winterhold', 'Windhelm',
  'Neverwinter', 'Waterdeep', 'Candlekeep', 'Saltmarsh', 'Stormreach', 'Baldurs Gate', 'Hearthstone', 'Stonehearth',
  'Starfield', 'Stardew', 'Ashenvale', 'Duskwood', 'Silverpine', 'Darkshore', 'Moonglade', 'Lakeshire', 'Moonbrook',
  'Oakvale', 'Oakfield', 'Rookridge', 'Bowerstone', 'Brightwall', 'Mistpeak', 'Brightwood', 'Crestwood', 'Redcliffe',
  'Skyhold', 'Hyrule', 'Kakariko', 'Saffron City', 'Pewter City', 'Cerulean City', 'Lavender Town', 'Pallet Town',
  'Goldenrod City', 'Blackthorn City', 'Sandgem Town', 'Turffield', 'Embervale',
  // fiction
  'Stormhold', 'Winterfell', 'Riverrun', 'Highgarden', 'Dragonstone', 'Rivendell', 'Hobbiton', 'Isengard', 'Hogwarts',
  'Hogsmeade', 'Thornfield', 'Copperfield', 'Lark Rise', 'Gotham', 'Metropolis', 'Smallville', 'Narnia',
  // brands and organisations
  'Corsair', 'Martens', 'Merlin', 'Silvergate', 'Stonegate', 'Silver Cross', 'Vanguard',
  // famous places and sports clubs outside football
  'Birchfield', 'Oak Ridge', 'Granite City', 'Iron Cross', 'Silicon Valley', 'Wimbledon', 'Twickenham', 'Lords',
  'Wentworth', 'Sunningdale', 'Gleneagles', 'Silverstone', 'Brands Hatch', 'Ascot', 'Aintree', 'Henley',
];

/** Three-letter abbreviations of real clubs (broadcast / league table codes). */
export const REAL_CLUB_CODES: readonly string[] = [
  // England
  'ARS', 'AVL', 'BOU', 'BRE', 'BHA', 'BUR', 'CHE', 'CRY', 'EVE', 'FUL', 'IPS', 'LEE', 'LEI', 'LIV', 'LUT', 'MCI',
  'MUN', 'NEW', 'NFO', 'NOR', 'SHU', 'SHW', 'SOU', 'SUN', 'TOT', 'WAT', 'WBA', 'WHU', 'WOL', 'BIR', 'BLB', 'BLA',
  'BOL', 'BRC', 'BRR', 'CAR', 'COV', 'DER', 'HUD', 'HUL', 'MID', 'MIL', 'OXF', 'OXU', 'PLY', 'POR', 'PNE', 'QPR',
  'REA', 'ROT', 'STK', 'SWA', 'WIG', 'WYC', 'BAR', 'BRA', 'CAM', 'CHA', 'CHL', 'CHS', 'COL', 'CRA', 'CRE', 'DON',
  'EXE', 'FLE', 'FGR', 'GIL', 'GRI', 'HAR', 'LIN', 'MAN', 'MOR', 'NOT', 'NTN', 'OLD', 'PET', 'PVA', 'SAL', 'SHR',
  'STE', 'STO', 'SWI', 'TRA', 'WAL', 'WIM', 'WRE', 'ACC', 'BRO', 'CRL', 'LEY', 'MKD', 'NPT', 'SCU', 'SOT', 'SUT',
  'TOR', 'YEO', 'HAT', 'HAL', 'YOR', 'MAC', 'ROC', 'HER', 'KID', 'DAG', 'ALD', 'GAT', 'WOK',
  // Scotland, Ireland
  'CEL', 'RAN', 'RFC', 'ABE', 'HEA', 'HIB', 'DUN', 'DUU', 'MOT', 'KIL', 'SJN', 'STJ', 'STM', 'ROS', 'ICT', 'PAR',
  'HAM', 'FAL', 'RAI', 'AYR', 'QOS', 'ARB', 'SHA', 'SHE', 'DER', 'DUN', 'LFC',
  // Spain, Germany, Italy, France
  'RMA', 'FCB', 'ATM', 'ATL', 'SEV', 'VAL', 'VIL', 'RSO', 'ATH', 'BET', 'ESP', 'GET', 'OSA', 'MLL', 'GIR', 'RAY',
  'ALA', 'LPA', 'LEG', 'CAD', 'GRA', 'ALM', 'ELC', 'VLL', 'DEP', 'ZAR', 'OVI', 'SPG', 'BAY', 'BVB', 'DOR', 'RBL',
  'LEV', 'B04', 'S04', 'SVW', 'HSV', 'VFB', 'SGE', 'WOB', 'TSG', 'FCU', 'BSC', 'KOE', 'SCF', 'M05', 'FCA', 'BOC',
  'HDH', 'STP', 'KIE', 'BMG', 'FCN', 'FCK', 'H96', 'JUV', 'INT', 'ACM', 'NAP', 'ROM', 'LAZ', 'ATA', 'FIO', 'BOL',
  'UDI', 'SAM', 'GEN', 'PAR', 'SAS', 'VER', 'CAG', 'LEC', 'EMP', 'MON', 'SPE', 'CRE', 'FRO', 'COM', 'VEN', 'PAL',
  'PSG', 'MAR', 'LYO', 'ASM', 'LIL', 'NIC', 'OGC', 'REN', 'SRF', 'RCL', 'LEN', 'NAN', 'BOR', 'ASS', 'STR', 'MTP',
  'TFC', 'TOU', 'REI', 'HAC', 'AJA', 'AUX', 'LOR', 'ANG', 'MET',
  // Rest of Europe
  'AJX', 'PSV', 'FEY', 'AZA', 'TWE', 'UTR', 'VIT', 'HEE', 'SLB', 'BEN', 'FCP', 'SCP', 'SPO', 'SCB', 'GUI', 'VSC',
  'BOA', 'AND', 'BRU', 'CLB', 'GNK', 'SCL', 'ANT', 'GNT', 'GAL', 'FEN', 'BES', 'TRA', 'OLY', 'PAO', 'AEK', 'PAK',
  'CZV', 'PAR', 'DIN', 'HAJ', 'SPA', 'SLA', 'PLZ', 'LEG', 'FTC', 'FER', 'FCS', 'DYN', 'SHK', 'ZEN', 'SPM', 'CSK',
  'LOK', 'BAS', 'YBB', 'GCZ', 'SAL', 'RBS', 'RAP', 'FAK', 'STU', 'FCC', 'BIF', 'MFF', 'AIK', 'DIF', 'RBK', 'MOL',
  'BOD', 'HJK',
  // Americas
  'RIV', 'IND', 'RAC', 'SLO', 'EST', 'VEL', 'NOB', 'RCE', 'FLA', 'FLU', 'BOT', 'VAS', 'COR', 'PAL', 'SAO', 'SAN',
  'GRE', 'CRU', 'CAM', 'PEN', 'NAC', 'CCO', 'UCH', 'AME', 'CHV', 'CAZ', 'PUM', 'MTY', 'TIG', 'TOL', 'OLI', 'LDU',
  'ALI', 'UNI', 'MIO', 'LAG', 'LAF', 'SEA', 'POR', 'MIA', 'NYR', 'NYC', 'VAN', 'MTL', 'CLB', 'CHI', 'DCU', 'SKC',
  'RSL', 'HOU', 'DAL', 'COL', 'SJE', 'MIN', 'ORL', 'PHI', 'NER', 'NSH', 'ATX', 'CIN', 'CLT', 'STL', 'NYK',
  // Africa, Asia, Oceania
  'AHL', 'ZAM', 'HIL', 'NAS', 'ITT', 'KAI', 'OPI', 'MSU', 'EST', 'RCA', 'WAC', 'MAZ', 'URA', 'KAS', 'YFM', 'KAW',
  'JEO', 'ULS', 'POH', 'GZE', 'MVC', 'MCY', 'SYD', 'WSW', 'BRI', 'WEL', 'AUC',
];

/** National-team codes (FIFA): a club code must not read as a country. */
export const NATION_CODES: readonly string[] = [
  'ENG', 'SCO', 'WAL', 'NIR', 'IRL', 'FRA', 'GER', 'ESP', 'ITA', 'POR', 'NED', 'BEL', 'SUI', 'AUT', 'DEN', 'SWE',
  'NOR', 'FIN', 'ISL', 'POL', 'CZE', 'SVK', 'HUN', 'ROU', 'BUL', 'GRE', 'TUR', 'CRO', 'SRB', 'SVN', 'BIH', 'MNE',
  'ALB', 'MKD', 'UKR', 'RUS', 'BLR', 'GEO', 'ARM', 'AZE', 'ISR', 'CYP', 'LUX', 'LTU', 'LVA', 'EST', 'MDA', 'BRA',
  'ARG', 'URU', 'PAR', 'CHI', 'COL', 'PER', 'ECU', 'BOL', 'VEN', 'MEX', 'USA', 'CAN', 'CRC', 'PAN', 'HON', 'JAM',
  'SLV', 'GUA', 'HAI', 'TRI', 'JPN', 'KOR', 'PRK', 'CHN', 'AUS', 'NZL', 'KSA', 'IRN', 'IRQ', 'QAT', 'UAE', 'JOR',
  'SYR', 'OMA', 'BHR', 'KUW', 'UZB', 'IND', 'THA', 'VIE', 'IDN', 'MAS', 'PHI', 'EGY', 'MAR', 'TUN', 'ALG', 'NGA',
  'GHA', 'CMR', 'CIV', 'SEN', 'RSA', 'MLI', 'BFA', 'GUI', 'COD', 'ZAM', 'ANG', 'CPV', 'GAB', 'KEN',
];

/** Abbreviations that read as offensive, crude or loaded. */
export const OFFENSIVE_CODES: readonly string[] = [
  'ASS', 'FUK', 'FUC', 'FCK', 'FKU', 'SEX', 'CUM', 'TIT', 'FAG', 'GAY', 'NAZ', 'KKK', 'WTF', 'POO', 'PEE', 'PIS',
  'DIE', 'KIL', 'RAP', 'NIG', 'NGR', 'JEW', 'GOD', 'HIV', 'STD', 'BUM', 'COK', 'DIK', 'DIC', 'VAG', 'PUS', 'PMS',
  'XXX', 'SUX', 'FAT', 'LSD', 'THC', 'WAR', 'GUN', 'SOB', 'HOE', 'TWT', 'CNT', 'SHT', 'IRA', 'ETA', 'SSS',
  'KYS', 'LOL', 'OMG', 'POW', 'DED', 'PIG', 'RAT', 'APE', 'NUT', 'ANL', 'CRP', 'BTC', 'CIA', 'FBI', 'KGB', 'NSA',
];

// ---------------------------------------------------------------- screening

export type ClubScreenReason = 'full' | 'token' | 'contains' | 'near' | 'nickname' | 'offensive';

export interface ClubScreenHit {
  reason: ClubScreenReason;
  /** The denylist key (compact, lowercase) that matched. */
  match: string;
}

interface ClubIndex {
  /** Compact keys of REAL_CLUB_NAMES. */
  full: string[];
  /** Parallel to `full`: the real name has two or more words (the screen then also rejects containment). */
  fullMulti: boolean[];
  tokens: string[];
  tokenSet: Set<string>;
  nicknames: Set<string>;
  codes: Set<string>;
}

/** Singular stem of a compact word list entry ("puffins" -> "puffin", "falls" -> "fall"): word stems that must not
 *  repeat across clubs, and emblem-hint keys. */
function singular(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith('es') && /(ss|x|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/** A compact word and its plural-stripped forms ("magpies" -> "magpie", "canaries" -> "canary", "foxes" -> "fox"). */
function variants(w: string): string[] {
  const out = [w];
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) out.push(w.slice(0, -1));
  if (w.length > 4 && w.endsWith('es')) out.push(w.slice(0, -2));
  if (w.length > 4 && w.endsWith('ies')) out.push(`${w.slice(0, -3)}y`);
  return out;
}

function buildIndex(): ClubIndex {
  const tokens = [...new Set(REAL_CLUB_TOKENS.map(nameKey))].filter((t) => t.length > 0);
  const nicknames = new Set<string>();
  for (const n of FAMOUS_NICKNAMES) for (const v of variants(nameKey(n))) nicknames.add(v);
  const codes = new Set<string>();
  for (const c of [...REAL_CLUB_CODES, ...NATION_CODES, ...OFFENSIVE_CODES]) if (/^[A-Z]{3}$/.test(c)) codes.add(c);
  const full: string[] = [];
  const fullMulti: boolean[] = [];
  const addFull = (n: string): void => {
    const k = nameKey(n);
    if (k.length === 0 || full.includes(k)) return;
    full.push(k);
    fullMulti.push(nameWords(n).length >= 2);
  };
  for (const n of REAL_CLUB_NAMES) addFull(n);
  for (const n of FAMOUS_NAMES) {
    if (nameWords(n).length >= 2) addFull(n);
    const k = nameKey(n);
    if (k.length > 0 && !tokens.includes(k)) tokens.push(k);
  }
  return {
    full,
    fullMulti,
    tokens,
    tokenSet: new Set(tokens),
    nicknames,
    codes,
  };
}

const INDEX = buildIndex();

/** Words (compact keys) of a name: "Harbour Vale FC" -> ["harbour", "vale", "fc"]. */
export function nameWords(s: string): string[] {
  return normalizeName(s).split(' ').filter((w) => w.length > 0);
}

/** Generic club words (suffixes and prefixes) that the token rules skip: "Rangers" in "Saltmere Rangers" is not
 *  the Glasgow club, and must not trip the substring rule on "Angers" either. */
const GENERIC_WORDS: readonly string[] = [...CLUB_SUFFIXES, ...CLUB_PREFIXES].map(nameKey);

/**
 * Screen a club name and its city. Returns null when both are allowed, or the first rule broken (see the header).
 * A real club's full name is rejected when the name or city equals it, or, for multi-word real names, contains it.
 * The token, near-miss and nickname rules look at the distinctive words only (generic suffixes skipped) and at
 * those words joined ("Salt Lake" -> "saltlake").
 */
export function screenClubName(name: string, city: string): ClubScreenHit | null {
  const all = [...nameWords(name), ...nameWords(city)];
  const whole = [nameKey(name), nameKey(city)];
  for (let i = 0; i < INDEX.full.length; i++) {
    const f = INDEX.full[i]!;
    const multi = INDEX.fullMulti[i]!;
    for (const h of whole) if (h === f || (multi && h.includes(f))) return { reason: 'full', match: f };
  }
  const words = all.filter((w) => !GENERIC_WORDS.includes(w));
  const hay = [...words, nameWords(name).filter((w) => !GENERIC_WORDS.includes(w)).join(''), nameKey(city)];
  for (const h of hay) if (INDEX.tokenSet.has(h)) return { reason: 'token', match: h };
  for (const t of INDEX.tokens) {
    if (t.length >= 5) {
      for (const h of hay) if (h.includes(t)) return { reason: 'contains', match: t };
    } else if (t.length === 4) {
      for (const w of words) if (w.startsWith(t)) return { reason: 'contains', match: t };
    }
  }
  for (const w of words) {
    if (w.length < 5) continue;
    for (const t of INDEX.tokens) if (t.length >= 6 && withinOneEdit(w, t)) return { reason: 'near', match: t };
  }
  for (const w of words) {
    for (const v of variants(w)) if (INDEX.nicknames.has(v)) return { reason: 'nickname', match: v };
  }
  for (const h of [...all, ...whole]) {
    for (const frag of OFFENSIVE_FRAGMENTS) if (h.includes(frag)) return { reason: 'offensive', match: frag };
  }
  return null;
}

/** True when `code` is three capital letters and not a real club, national-team or offensive code. */
export function isCodeAllowed(code: string): boolean {
  return /^[A-Z]{3}$/.test(code) && !INDEX.codes.has(code);
}

/** Size of the denylists (report / tests). */
export function clubDenylistSizes(): { names: number; tokens: number; nicknames: number; codes: number } {
  return { names: INDEX.full.length, tokens: INDEX.tokens.length, nicknames: INDEX.nicknames.size, codes: INDEX.codes.size };
}

// ---------------------------------------------------------------- codes

const VOWELS = 'AEIOU';

/**
 * Candidate codes for a club, best first, from its distinctive words (place or emblem words, not the generic
 * suffix): first three letters; initials of the distinctive words plus the next consonant; first letter plus two
 * later consonants; first letter plus any two later letters. Duplicates removed.
 */
export function codeCandidates(distinctive: readonly string[]): string[] {
  const words = distinctive.map((w) => nameKey(w).toUpperCase()).filter((w) => w.length > 0);
  if (words.length === 0) return [];
  const compact = words.join('');
  const out: string[] = [];
  const add = (c: string): void => {
    if (c.length === 3 && !out.includes(c)) out.push(c);
  };
  add(compact.slice(0, 3));
  if (words.length >= 2) {
    const w2 = words[1]!;
    for (let i = 1; i < w2.length; i++) {
      if (!VOWELS.includes(w2[i]!)) { add(words[0]![0]! + w2[0]! + w2[i]!); break; }
    }
    add(words[0]!.slice(0, 2) + w2[0]!);
  }
  const first = compact[0]!;
  const cons: number[] = [];
  for (let i = 1; i < compact.length; i++) if (!VOWELS.includes(compact[i]!)) cons.push(i);
  for (let a = 0; a < cons.length; a++) for (let b = a + 1; b < cons.length; b++) add(first + compact[cons[a]!]! + compact[cons[b]!]!);
  for (let a = 1; a < compact.length; a++) for (let b = a + 1; b < compact.length; b++) add(first + compact[a]! + compact[b]!);
  return out;
}

/** First allowed candidate code not in `used`, or null. */
export function pickCode(distinctive: readonly string[], used: ReadonlySet<string>): string | null {
  for (const c of codeCandidates(distinctive)) if (isCodeAllowed(c) && !used.has(c)) return c;
  return null;
}

// ---------------------------------------------------------------- name generation

export enum ClubNameTemplate {
  PLACE_SUFFIX = 0,
  PLACE_APART = 1,
  PLACE_NICKNAME = 2,
  EMBLEM_SUFFIX = 3,
  FC_PLACE = 4,
}

/** Relative weight and maximum count per template in one league. */
export const TEMPLATE_RULES: readonly { weight: number; max: number }[] = [
  { weight: 7, max: 8 }, // PLACE_SUFFIX
  { weight: 3, max: 4 }, // PLACE_APART
  { weight: 3, max: 4 }, // PLACE_NICKNAME
  { weight: 2, max: 3 }, // EMBLEM_SUFFIX
  { weight: 1, max: 2 }, // FC_PLACE
];

export interface ClubNameParts {
  name: string;
  city: string;
  template: ClubNameTemplate;
  /** Distinctive words the code is built from ("Saltmere", or "Harbour" + "Vale", or "Kestrel"). */
  distinctive: string[];
  /** Word stems (compact, singular) that make the name distinctive: no two clubs share one. */
  stems: string[];
  /** Tail word key of the place in the name ('' when the name has no place). */
  tail: string;
  /** Suffix or prefix key ('' for nickname / apart names). */
  suffix: string;
}

function cap(w: string): string {
  return w.charAt(0).toUpperCase() + w.slice(1);
}

function pickIndex(next: () => number, n: number): number {
  const i = Math.floor(next() * n);
  return i < n ? i : n - 1;
}

function pickOf<T>(next: () => number, items: readonly T[]): T {
  return items[pickIndex(next, items.length)]!;
}

interface Place {
  /** As shown: "Saltmere" or "Harbour Vale". */
  text: string;
  head: string;
  tail: string;
  joined: boolean;
}

/** A place name: head + tail, joined into one word when short enough and the tail allows, else two words. */
function drawPlace(next: () => number, apart: boolean): Place | null {
  const head = pickOf(next, PLACE_HEADS);
  const tail = pickOf(next, PLACE_TAILS);
  if (apart) {
    if (!tail.apart) return null;
    return { text: `${head} ${cap(tail.word)}`, head, tail: tail.word, joined: false };
  }
  if (!tail.join || head.length + tail.word.length > PLACE_JOIN_MAX) return null;
  // A doubled letter at the seam reads badly ("Reed" + "dale"); skip it.
  if (head.charAt(head.length - 1).toLowerCase() === tail.word.charAt(0)) return null;
  return { text: head + tail.word, head, tail: tail.word, joined: true };
}

function stemOf(w: string): string {
  return singular(nameKey(w));
}

/** One raw candidate for a template (not yet screened or checked for uniqueness). */
function drawCandidate(next: () => number, template: ClubNameTemplate): ClubNameParts | null {
  switch (template) {
    case ClubNameTemplate.PLACE_SUFFIX: {
      const p = drawPlace(next, false);
      const suffix = pickOf(next, CLUB_SUFFIXES);
      if (p === null) return null;
      return {
        name: `${p.text} ${suffix}`, city: p.text, template, distinctive: [p.text], stems: [stemOf(p.head)],
        tail: nameKey(p.tail), suffix: nameKey(suffix),
      };
    }
    case ClubNameTemplate.PLACE_APART: {
      const p = drawPlace(next, true);
      if (p === null) return null;
      return {
        name: p.text, city: p.text, template, distinctive: [p.head, p.tail], stems: [stemOf(p.head)],
        tail: nameKey(p.tail), suffix: '',
      };
    }
    case ClubNameTemplate.PLACE_NICKNAME: {
      const p = drawPlace(next, false);
      const nick = pickOf(next, CLUB_NICKNAMES);
      if (p === null) return null;
      return {
        name: `${p.text} ${nick}`, city: p.text, template, distinctive: [p.text],
        stems: [stemOf(p.head), stemOf(nick)], tail: nameKey(p.tail), suffix: '',
      };
    }
    case ClubNameTemplate.EMBLEM_SUFFIX: {
      const word = pickOf(next, EMBLEM_WORDS);
      const suffix = pickOf(next, CLUB_SUFFIXES);
      const p = drawPlace(next, false);
      if (p === null) return null;
      return {
        name: `${word} ${suffix}`, city: p.text, template, distinctive: [word], stems: [stemOf(word), stemOf(p.head)],
        tail: nameKey(p.tail), suffix: nameKey(suffix),
      };
    }
    case ClubNameTemplate.FC_PLACE: {
      const prefix = pickOf(next, CLUB_PREFIXES);
      const p = drawPlace(next, false);
      if (p === null) return null;
      return {
        name: `${prefix} ${p.text}`, city: p.text, template, distinctive: [p.text], stems: [stemOf(p.head)],
        tail: nameKey(p.tail), suffix: nameKey(prefix),
      };
    }
    default:
      return null;
  }
}

function drawTemplate(next: () => number, counts: readonly number[]): ClubNameTemplate {
  let total = 0;
  for (let t = 0; t < TEMPLATE_RULES.length; t++) if (counts[t]! < TEMPLATE_RULES[t]!.max) total += TEMPLATE_RULES[t]!.weight;
  let u = next() * total;
  for (let t = 0; t < TEMPLATE_RULES.length; t++) {
    if (counts[t]! >= TEMPLATE_RULES[t]!.max) continue;
    u -= TEMPLATE_RULES[t]!.weight;
    if (u < 0) return t as ClubNameTemplate;
  }
  for (let t = TEMPLATE_RULES.length - 1; t >= 0; t--) if (counts[t]! < TEMPLATE_RULES[t]!.max) return t as ClubNameTemplate;
  throw new Error('names: every template is at its maximum count');
}

/**
 * Generate `count` screened, distinct club names (in draw order). Distinct means: no shared name, city, word stem
 * or code; a suffix at most maxSuffixUses times and a place tail at most maxTailUses times (LOCAL_TUNING); template
 * counts within TEMPLATE_RULES (so `count` <= 21); every club gets an allowed, unique code (`code` in the result).
 * Deterministic for a given uniform [0, 1) source.
 */
export function generateClubNames(next: () => number, count: number): (ClubNameParts & { code: string })[] {
  const out: (ClubNameParts & { code: string })[] = [];
  const names = new Set<string>();
  const stems = new Set<string>();
  const codes = new Set<string>();
  const tailUses = new Map<string, number>();
  const suffixUses = new Map<string, number>();
  const counts = TEMPLATE_RULES.map(() => 0);
  for (let i = 0; i < count; i++) {
    let done = false;
    for (let attempt = 0; attempt < LOCAL_TUNING.maxAttempts && !done; attempt++) {
      const c = drawCandidate(next, drawTemplate(next, counts));
      if (c === null) continue;
      if (c.name.length > LOCAL_TUNING.maxNameLength || c.city.length > LOCAL_TUNING.maxCityLength) continue;
      if (names.has(nameKey(c.name)) || names.has(nameKey(c.city))) continue;
      if (c.stems.some((s) => stems.has(s))) continue;
      if (c.tail !== '' && (tailUses.get(c.tail) ?? 0) >= LOCAL_TUNING.maxTailUses) continue;
      if (c.suffix !== '' && (suffixUses.get(c.suffix) ?? 0) >= LOCAL_TUNING.maxSuffixUses) continue;
      if (screenClubName(c.name, c.city) !== null) continue;
      const code = pickCode(c.distinctive, codes);
      if (code === null) continue;
      names.add(nameKey(c.name));
      names.add(nameKey(c.city));
      for (const s of c.stems) stems.add(s);
      codes.add(code);
      if (c.tail !== '') tailUses.set(c.tail, (tailUses.get(c.tail) ?? 0) + 1);
      if (c.suffix !== '') suffixUses.set(c.suffix, (suffixUses.get(c.suffix) ?? 0) + 1);
      counts[c.template] = counts[c.template]! + 1;
      out.push({ ...c, code });
      done = true;
    }
    if (!done) throw new Error(`names: no screened, distinct club name for club ${i} after ${LOCAL_TUNING.maxAttempts} draws`);
  }
  return out;
}

/** Read-only view of the name rules (tests / tools). */
export const CLUB_NAME_RULES = LOCAL_TUNING;

// ---------------------------------------------------------------- crest emblem hints

/**
 * Crest emblem ids (contracts/data.ts Crest.emblem; names in data/clubs.ts CREST_EMBLEMS) that suit a word, so a
 * crest can echo the name ("Comet" -> star, "Tide" -> wave). Keys are compact singular stems.
 */
export const EMBLEM_HINTS: Readonly<Record<string, number>> = {
  comet: 0, meteor: 0, starling: 0, orbit: 3,
  storm: 1, tempest: 1, spark: 1, flint: 1, cinder: 1,
  tide: 2, mere: 2, brook: 2, bay: 2, fall: 2, shore: 2, harbour: 2, coral: 2, cascade: 2, otter: 2, anchor: 2,
  summit: 4, granite: 4, slate: 4, quarry: 4, tor: 4, fell: 4, ridge: 4, cliff: 4,
  swift: 5, kestrel: 5, falcon: 5, kite: 5, sparrow: 5, wren: 5, lark: 5, rook: 5, raven: 5, jackdaw: 5, crane: 5,
  curlew: 5, lapwing: 5,
  amber: 7, gold: 7, saffron: 7, ember: 7, bright: 7, ochre: 7, lantern: 7, beacon: 7,
  pebble: 8, sand: 8, salt: 8, clay: 8,
  quartz: 9, onyx: 9, garnet: 9, glass: 9, marble: 9, cobalt: 9,
};

/** Emblem hint for a club name: the first stem with a hint (distinctive stems, then the place tail, then the name
 *  words), or -1. */
export function emblemHint(parts: Pick<ClubNameParts, 'name' | 'stems' | 'tail'>): number {
  const keys = [...parts.stems, singular(parts.tail), ...nameWords(parts.name).map(singular)];
  for (const k of keys) if (Object.prototype.hasOwnProperty.call(EMBLEM_HINTS, k)) return EMBLEM_HINTS[k]!;
  return -1;
}
