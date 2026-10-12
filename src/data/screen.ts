/**
 * [DAT-02] Name screening for generated players (BRIEF §2, §15: "Names ... must not match real footballers;
 * screen the output against famous names.").
 *
 * Holds a denylist of famous real footballers (full names, a few hundred, legends and current stars) plus
 * mononyms, a short list of iconic surnames, and a small list of offensive fragments. `screenName` rejects:
 *   1. 'full'            first + surname equal a famous full name (accent/case/punctuation-insensitive);
 *   2. 'surname-initial' surname (or one part of a hyphenated / particle surname) equals a famous surname AND the
 *                        first initial matches ("L. Messi"-style display collisions);
 *   3. 'iconic'          any name part equals a mononym ("Pele", "Kaka") or an iconic surname, whatever the initial;
 *   4. 'near-iconic'     a surname part is one edit away from an iconic surname of 5+ letters ("Messy", "Zidan");
 *   5. 'famous-surname'  (strict mode only) the surname equals ANY famous surname, whatever the initial. The
 *                        generator runs strict so generated names never borrow a famous footballer's surname;
 *   6. 'offensive'       a part contains an offensive fragment.
 *
 * Generation-time only (tools/gen-data.ts via src/data/playerGen.ts); never imported by sim/ai code.
 * Korean names are listed given-name first so the family name sits in the surname position.
 */

export type ScreenReason = 'full' | 'surname-initial' | 'iconic' | 'near-iconic' | 'famous-surname' | 'offensive';

export interface ScreenHit {
  reason: ScreenReason;
  /** The denylist entry (normalised) that matched. */
  match: string;
}

/** Famous real footballers, "Given Surname" (surname = everything after the first word). */
export const FAMOUS_PLAYERS: readonly string[] = [
  // ---- legends (before ~1995)
  'Diego Maradona', 'Johan Cruyff', 'Franz Beckenbauer', 'Alfredo Di Stefano', 'Ferenc Puskas', 'George Best',
  'Bobby Charlton', 'Bobby Moore', 'Gerd Muller', 'Michel Platini', 'Marco van Basten', 'Ruud Gullit',
  'Frank Rijkaard', 'Lev Yashin', 'Dino Zoff', 'Gordon Banks', 'Paolo Rossi', 'Kevin Keegan', 'Stanley Matthews',
  'Kenny Dalglish', 'Denis Law', 'Ian Rush', 'Gary Lineker', 'Paul Gascoigne', 'Peter Shilton', 'Lothar Matthaus',
  'Karl-Heinz Rummenigge', 'Jurgen Klinsmann', 'Rudi Voller', 'Sepp Maier', 'Paul Breitner', 'Gunter Netzer',
  'Uwe Seeler', 'Johan Neeskens', 'Ruud Krol', 'Hristo Stoichkov', 'Gheorghe Hagi', 'Roberto Baggio',
  'Franco Baresi', 'Paolo Maldini', 'Giacinto Facchetti', 'Gianni Rivera', 'Sandro Mazzola', 'Gianluca Vialli',
  'Roberto Mancini', 'Eric Cantona', 'Jean-Pierre Papin', 'Mario Kempes', 'Daniel Passarella', 'Claudio Caniggia',
  'Enzo Francescoli', 'Carlos Valderrama', 'Rene Higuita', 'Faustino Asprilla', 'Hugo Sanchez', 'Roger Milla',
  'George Weah', 'Abedi Pele', 'Rabah Madjer', 'Michael Laudrup', 'Brian Laudrup', 'Peter Schmeichel',
  'Jari Litmanen', 'Zbigniew Boniek', 'Grzegorz Lato', 'Oleg Blokhin', 'Igor Belanov', 'Davor Suker',
  'Zvonimir Boban', 'Dragan Stojkovic', 'Dejan Savicevic', 'Predrag Mijatovic', 'Ivan Zamorano', 'Marcelo Salas',
  'Carlos Alberto', 'Roberto Carlos', 'Teofilo Cubillas', 'Elias Figueroa', 'Ali Daei', 'Bum-kun Cha',
  'Kazuyoshi Miura', 'Enzo Scifo', 'Jean-Marie Pfaff', 'Rinat Dasayev', 'Gianfranco Zola', 'Ruud van Nistelrooy',
  // ---- 1995-2015
  'Zinedine Zidane', 'Thierry Henry', 'Patrick Vieira', 'Marcel Desailly', 'Lilian Thuram', 'Laurent Blanc',
  'Didier Deschamps', 'Robert Pires', 'Claude Makelele', 'David Trezeguet', 'Djibril Cisse', 'Franck Ribery',
  'Samir Nasri', 'Patrice Evra', 'Bacary Sagna', 'Florent Malouda', 'Nicolas Anelka', 'Fabien Barthez',
  'Youri Djorkaeff', 'Christian Karembeu', 'Bixente Lizarazu', 'Emmanuel Petit', 'Sylvain Wiltord',
  'Ludovic Giuly', 'Hatem Ben Arfa', 'Yoann Gourcuff', 'Mathieu Valbuena', 'Luis Figo', 'Rui Costa',
  'Cristiano Ronaldo', 'Ricardo Carvalho', 'Ricardo Quaresma', 'Simao Sabrosa', 'Nuno Gomes', 'Paulo Futre',
  'Fernando Couto', 'Joao Moutinho', 'Raul Meireles', 'David Beckham', 'Wayne Rooney', 'Steven Gerrard',
  'Frank Lampard', 'Alan Shearer', 'Michael Owen', 'John Terry', 'Rio Ferdinand', 'Ashley Cole', 'Paul Scholes',
  'Gary Neville', 'Sol Campbell', 'David Seaman', 'Teddy Sheringham', 'Ian Wright', 'Robbie Fowler',
  'Jamie Carragher', 'Michael Carrick', 'Peter Crouch', 'Jermain Defoe', 'Joe Cole', 'Theo Walcott',
  'Jack Wilshere', 'Ryan Giggs', 'Gareth Bale', 'Aaron Ramsey', 'Craig Bellamy', 'Roy Keane', 'Robbie Keane',
  'Damien Duff', 'Shay Given', 'Alessandro Del Piero', 'Francesco Totti', 'Andrea Pirlo', 'Gianluigi Buffon',
  'Fabio Cannavaro', 'Alessandro Nesta', 'Gennaro Gattuso', 'Filippo Inzaghi', 'Christian Vieri',
  'Daniele De Rossi', 'Giorgio Chiellini', 'Leonardo Bonucci', 'Mario Balotelli', 'Antonio Cassano', 'Luca Toni',
  'Gianluca Zambrotta', 'Andrea Barzagli', 'Claudio Marchisio', 'Marco Verratti', 'Lorenzo Insigne',
  'Ciro Immobile', 'Iker Casillas', 'Carles Puyol', 'Xavi Hernandez', 'Andres Iniesta', 'Sergio Ramos',
  'Gerard Pique', 'Sergio Busquets', 'David Villa', 'Fernando Torres', 'Raul Gonzalez', 'Cesc Fabregas',
  'David Silva', 'Xabi Alonso', 'Jordi Alba', 'Fernando Hierro', 'Pep Guardiola', 'Gaizka Mendieta',
  'Fernando Morientes', 'Juan Mata', 'Santi Cazorla', 'Jesus Navas', 'Pedro Rodriguez', 'Diego Costa',
  'David de Gea', 'Alvaro Morata', 'Marco Asensio', 'Dani Carvajal', 'Oliver Kahn', 'Michael Ballack',
  'Philipp Lahm', 'Bastian Schweinsteiger', 'Miroslav Klose', 'Lukas Podolski', 'Per Mertesacker', 'Mesut Ozil',
  'Sami Khedira', 'Mario Gotze', 'Thomas Muller', 'Manuel Neuer', 'Toni Kroos', 'Mats Hummels', 'Jerome Boateng',
  'Kevin-Prince Boateng', 'Marco Reus', 'Ilkay Gundogan', 'Mario Gomez', 'Dennis Bergkamp', 'Patrick Kluivert',
  'Edgar Davids', 'Clarence Seedorf', 'Marc Overmars', 'Jaap Stam', 'Edwin van der Sar', 'Robin van Persie',
  'Arjen Robben', 'Wesley Sneijder', 'Rafael van der Vaart', 'Dirk Kuyt', 'Nigel de Jong', 'Mark van Bommel',
  'Frank de Boer', 'Ronald de Boer', 'Pavel Nedved', 'Petr Cech', 'Tomas Rosicky', 'Milan Baros', 'Jan Koller',
  'Marek Hamsik', 'Martin Skrtel', 'Zlatan Ibrahimovic', 'Henrik Larsson', 'Freddie Ljungberg',
  'Ole Gunnar Solskjaer', 'John Arne Riise', 'Sami Hyypia', 'Christian Eriksen', 'Daniel Agger',
  'Andriy Shevchenko', 'Andrei Arshavin', 'Dimitar Berbatov', 'Hakan Sukur', 'Rustu Recber', 'Emre Belozoglu',
  'Arda Turan', 'Nemanja Vidic', 'Branislav Ivanovic', 'Nemanja Matic', 'Dejan Stankovic', 'Sinisa Mihajlovic',
  'Luka Modric', 'Ivan Rakitic', 'Mario Mandzukic', 'Ivan Perisic', 'Darijo Srna', 'Niko Kovac', 'Robert Kovac',
  'Gabriel Batistuta', 'Lionel Messi', 'Sergio Aguero', 'Angel Di Maria', 'Carlos Tevez', 'Juan Roman Riquelme',
  'Javier Zanetti', 'Javier Mascherano', 'Hernan Crespo', 'Gonzalo Higuain', 'Juan Sebastian Veron',
  'Pablo Aimar', 'Ezequiel Lavezzi', 'Diego Simeone', 'Ariel Ortega', 'Esteban Cambiasso', 'Walter Samuel',
  'Pablo Zabaleta', 'Luis Suarez', 'Edinson Cavani', 'Diego Forlan', 'Diego Godin', 'Alvaro Recoba',
  'Diego Lugano', 'Radamel Falcao', 'James Rodriguez', 'Juan Cuadrado', 'David Ospina', 'Carlos Bacca',
  'Alexis Sanchez', 'Arturo Vidal', 'Claudio Bravo', 'Gary Medel', 'Rafael Marquez', 'Javier Hernandez',
  'Guillermo Ochoa', 'Andres Guardado', 'Carlos Vela', 'Giovani dos Santos', 'Landon Donovan', 'Clint Dempsey',
  'Tim Howard', 'Michael Bradley', 'Brian McBride', 'Brad Friedel', "Samuel Eto'o", 'Didier Drogba', 'Yaya Toure',
  'Kolo Toure', 'Augustine Okocha', 'Nwankwo Kanu', 'Michael Essien', 'Asamoah Gyan', 'Sulley Muntari',
  'Emmanuel Adebayor', 'Frederic Kanoute', 'El Hadji Diouf', 'Papa Bouba Diop', 'Mohamed Aboutrika',
  'Hossam Hassan', 'Ahmed Hassan', 'John Obi Mikel', 'Victor Moses', 'Seydou Keita', 'Benni McCarthy',
  'Lucas Radebe', 'Stephen Appiah', 'Emmanuel Eboue', 'Salomon Kalou', 'Ji-sung Park', 'Shunsuke Nakamura',
  'Hidetoshi Nakata', 'Keisuke Honda', 'Shinji Kagawa', 'Shinji Okazaki', 'Tim Cahill', 'Harry Kewell',
  'Mark Viduka', 'Mark Schwarzer', 'Sami Al-Jaber', 'Yasser Al-Qahtani', 'Peter Ndlovu', 'Thiago Silva',
  'David Luiz', 'Dani Alves', 'Julio Cesar', 'Gilberto Silva', 'Ze Roberto', 'Luis Fabiano', 'Alexandre Pato',
  'Douglas Costa', 'Philippe Coutinho', 'Lucas Moura', 'Thiago Alcantara',
  // ---- current era (2015-2026)
  'Kylian Mbappe', 'Erling Haaland', 'Jude Bellingham', 'Vinicius Junior', 'Mohamed Salah', 'Kevin De Bruyne',
  'Harry Kane', 'Robert Lewandowski', 'Karim Benzema', 'Virgil van Dijk', 'Sadio Mane', 'Heung-min Son',
  'Antoine Griezmann', 'Paul Pogba', "N'Golo Kante", 'Hugo Lloris', 'Raphael Varane', 'Olivier Giroud',
  'Ousmane Dembele', 'Aurelien Tchouameni', 'Eduardo Camavinga', 'William Saliba', 'Theo Hernandez',
  'Lucas Hernandez', 'Jules Kounde', 'Dayot Upamecano', 'Mike Maignan', 'Kingsley Coman', 'Marcus Thuram',
  'Randal Kolo Muani', 'Michael Olise', 'Bradley Barcola', 'Warren Zaire-Emery', 'Adrien Rabiot', 'Desire Doue',
  'Rayan Cherki', 'Bukayo Saka', 'Phil Foden', 'Declan Rice', 'Jack Grealish', 'Trent Alexander-Arnold',
  'Jordan Henderson', 'Kyle Walker', 'John Stones', 'Harry Maguire', 'Jordan Pickford', 'Mason Mount',
  'Cole Palmer', 'Kobbie Mainoo', 'Ollie Watkins', 'Ivan Toney', 'Jadon Sancho', 'Reece James', 'Luke Shaw',
  'Kieran Trippier', 'Jamie Vardy', 'Raheem Sterling', 'Marcus Rashford', 'Dele Alli', 'Eberechi Eze',
  'Anthony Gordon', 'Conor Gallagher', 'Marc Guehi', 'Jarrod Bowen', 'Morgan Rogers', 'Andrew Robertson',
  'Scott McTominay', 'John McGinn', 'Kieran Tierney', 'Gianluigi Donnarumma', 'Federico Chiesa', 'Nicolo Barella',
  'Sandro Tonali', 'Alessandro Bastoni', 'Federico Dimarco', 'Mateo Retegui', 'Gianluca Scamacca',
  'Riccardo Calafiori', 'Davide Frattesi', 'Andrea Belotti', 'Moise Kean', 'Lorenzo Pellegrini',
  'Giacomo Raspadori', 'Bruno Fernandes', 'Bernardo Silva', 'Joao Felix', 'Ruben Dias', 'Diogo Jota',
  'Rafael Leao', 'Joao Cancelo', 'Joao Neves', 'Nuno Mendes', 'Goncalo Ramos', 'Diogo Costa', 'Rui Patricio',
  'Ruben Neves', 'Frenkie de Jong', 'Matthijs de Ligt', 'Memphis Depay', 'Georginio Wijnaldum', 'Cody Gakpo',
  'Xavi Simons', 'Denzel Dumfries', 'Nathan Ake', 'Stefan de Vrij', 'Jeremie Frimpong', 'Tijjani Reijnders',
  'Eden Hazard', 'Romelu Lukaku', 'Thibaut Courtois', 'Vincent Kompany', 'Jan Vertonghen', 'Toby Alderweireld',
  'Axel Witsel', 'Dries Mertens', 'Youri Tielemans', 'Jeremy Doku', 'Leandro Trossard', 'Marouane Fellaini',
  'Lamine Yamal', 'Nico Williams', 'Inaki Williams', 'Ferran Torres', 'Dani Olmo', 'Unai Simon', 'Mikel Merino',
  'Martin Zubimendi', 'Fabian Ruiz', 'Mikel Oyarzabal', 'Alejandro Grimaldo', 'Pau Cubarsi', 'Joshua Kimmich',
  'Leon Goretzka', 'Kai Havertz', 'Jamal Musiala', 'Florian Wirtz', 'Leroy Sane', 'Serge Gnabry',
  'Antonio Rudiger', 'Marc-Andre ter Stegen', 'Niclas Fullkrug', 'Timo Werner', 'Lautaro Martinez',
  'Julian Alvarez', 'Emiliano Martinez', 'Enzo Fernandez', 'Alexis Mac Allister', 'Rodrigo De Paul',
  'Nicolas Otamendi', 'Cristian Romero', 'Lisandro Martinez', 'Paulo Dybala', 'Alejandro Garnacho',
  'Leandro Paredes', 'Giovani Lo Celso', 'Federico Valverde', 'Darwin Nunez', 'Ronald Araujo',
  'Rodrigo Bentancur', 'Manuel Ugarte', 'Luis Diaz', 'Jhon Duran', 'Hirving Lozano', 'Raul Jimenez',
  'Santiago Gimenez', 'Edson Alvarez', 'Christian Pulisic', 'Weston McKennie', 'Tyler Adams', 'Gio Reyna',
  'Alphonso Davies', 'Jonathan David', 'Josko Gvardiol', 'Mateo Kovacic', 'Marcelo Brozovic', 'Dejan Lovren',
  'Dominik Livakovic', 'Andrej Kramaric', 'Dusan Vlahovic', 'Aleksandar Mitrovic', 'Sergej Milinkovic-Savic',
  'Dusan Tadic', 'Wojciech Szczesny', 'Piotr Zielinski', 'Jakub Blaszczykowski', 'Lukasz Piszczek',
  'Jerzy Dudek', 'Patrik Schick', 'Milan Skriniar', 'Tomas Soucek', 'Martin Odegaard', 'Alexander Isak',
  'Dejan Kulusevski', 'Viktor Gyokeres', 'Rasmus Hojlund', 'Pierre-Emile Hojbjerg', 'Kasper Schmeichel',
  'Teemu Pukki', 'Victor Lindelof', 'Khvicha Kvaratskhelia', 'Oleksandr Zinchenko', 'Mykhailo Mudryk',
  'Arda Guler', 'Hakan Calhanoglu', 'Kenan Yildiz', 'Granit Xhaka', 'Xherdan Shaqiri', 'Manuel Akanji',
  'Yann Sommer', 'David Alaba', 'Marko Arnautovic', 'Dominik Szoboszlai', 'Jan Oblak', 'Benjamin Sesko',
  'Riyad Mahrez', 'Achraf Hakimi', 'Hakim Ziyech', 'Victor Osimhen', 'Ademola Lookman',
  'Pierre-Emerick Aubameyang', 'Kalidou Koulibaly', 'Edouard Mendy', 'Andre Onana', 'Thomas Partey',
  'Mohammed Kudus', 'Naby Keita', 'Wilfried Zaha', 'Sebastien Haller', 'Franck Kessie', 'Yassine Bounou',
  'Sofyan Amrabat', 'Brahim Diaz', 'Serhou Guirassy', 'Nicolas Jackson', 'Ismaila Sarr', 'Wilfred Ndidi',
  'Alex Iwobi', 'Kelechi Iheanacho', 'Bryan Mbeumo', 'Amad Diallo', 'Andre Ayew', 'Jordan Ayew', 'Yves Bissouma',
  'Idrissa Gueye', 'Nicolas Pepe', 'Omar Marmoush', 'Mohamed Elneny', 'Min-jae Kim', 'Kang-in Lee',
  'Hee-chan Hwang', 'Takefusa Kubo', 'Kaoru Mitoma', 'Takehiro Tomiyasu', 'Wataru Endo', 'Daichi Kamada',
  'Takumi Minamino', 'Maya Yoshida', 'Mehdi Taremi', 'Sardar Azmoun', 'Salem Al-Dawsari', 'Roberto Firmino',
  'Gabriel Jesus', 'Gabriel Martinelli', 'Lucas Paqueta', 'Bruno Guimaraes', 'Alex Sandro', 'Gabriel Magalhaes',
  'Joao Pedro', 'Gabriel Barbosa', 'Gleison Bremer', 'Emerson Royal',
];

/** Famous one-name players: rejected as ANY name part. */
export const FAMOUS_MONONYMS: readonly string[] = [
  'Pele', 'Eusebio', 'Garrincha', 'Zico', 'Socrates', 'Romario', 'Rivaldo', 'Ronaldinho', 'Ronaldo', 'Kaka',
  'Cafu', 'Bebeto', 'Dida', 'Adriano', 'Robinho', 'Juninho', 'Deco', 'Neymar', 'Marcelo', 'Casemiro',
  'Fernandinho', 'Fabinho', 'Jorginho', 'Oscar', 'Willian', 'Hulk', 'Fred', 'Alisson', 'Ederson', 'Raphinha',
  'Rodrygo', 'Antony', 'Endrick', 'Richarlison', 'Vitinha', 'Pepe', 'Nani', 'Xavi', 'Isco', 'Pedri', 'Gavi',
  'Rodri', 'Koke', 'Careca', 'Denilson', 'Lucio', 'Rafinha', 'Savinho', 'Gervinho', 'Jairzinho', 'Rivelino',
  'Tostao', 'Kanu', 'Falcao',
];

/** Surnames so tied to one player that any initial is rejected (and near-misses of 5+ letters too). */
export const ICONIC_SURNAMES: readonly string[] = [
  'Messi', 'Ronaldo', 'Maradona', 'Zidane', 'Cruyff', 'Beckenbauer', 'Beckham', 'Rooney', 'Gerrard', 'Lampard',
  'Ibrahimovic', 'Mbappe', 'Haaland', 'Puskas', 'Di Stefano', 'Platini', 'Maldini', 'Baggio', 'Totti', 'Pirlo',
  'Buffon', 'Iniesta', 'Casillas', 'Lewandowski', 'Modric', 'Salah', 'Drogba', "Eto'o", 'Weah', 'Bellingham',
  'Benzema', 'Griezmann', 'De Bruyne', 'Hazard', 'Cavani', 'Aguero', 'Batistuta', 'Figo', 'van Basten', 'Gullit',
  'Bergkamp', 'Robben', 'Shevchenko', 'Yashin', 'Cantona', 'Kroos', 'Neuer', 'Schweinsteiger', 'Ozil', 'Pogba',
  'Kante', 'Lukaku', 'van Dijk', 'Kvaratskhelia', 'Yamal', 'Musiala', 'Wirtz', 'Foden', 'Valderrama', 'Higuita',
  'Okocha', 'Matthaus', 'Klinsmann', 'Rummenigge', 'Schmeichel', 'Laudrup', 'Stoichkov', 'Hagi', 'Nedved',
  'Ribery', 'Gascoigne', 'Shearer', 'Lineker', 'Dalglish', 'Eusebio', 'Pele', 'Kaka', 'Neymar', 'Ronaldinho',
];

/** Fragments that must never appear inside a generated name part (letters only, lowercase). */
export const OFFENSIVE_FRAGMENTS: readonly string[] = [
  'fuck', 'shit', 'cunt', 'nigg', 'nigr', 'fag', 'rape', 'nazi', 'hitler', 'porn', 'slut', 'whore', 'piss', 'cock',
  'dick', 'twat', 'wank', 'bitch', 'penis', 'vagin', 'anus', 'arse', 'kkk', 'jizz', 'tits', 'boob', 'homo',
  'retard', 'spic', 'kike', 'chink', 'gook', 'paki', 'coon', 'dyke', 'tranny', 'wog', 'wop', 'slag', 'bollock',
  'bastard', 'crap', 'turd', 'poop', 'sex', 'nude', 'kill', 'dead', 'satan', 'semen', 'scum', 'idiot', 'moron',
];

/** Letters with no Unicode decomposition, mapped by hand. */
const SPECIAL_LETTERS: Readonly<Record<string, string>> = {
  'ø': 'o', 'æ': 'ae', 'œ': 'oe', 'ß': 'ss', 'ł': 'l', 'đ': 'd', 'ð': 'd', 'þ': 'th', 'ı': 'i', 'ħ': 'h',
};

/** Lowercase, strip accents, map special letters, collapse every non-letter run to one space, trim. */
export function normalizeName(s: string): string {
  let out = s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  out = out.replace(/[øæœßłđðþıħ]/g, (c) => SPECIAL_LETTERS[c] ?? c);
  return out.replace(/[^a-z]+/g, ' ').trim();
}

/** normalizeName without spaces: the key every comparison uses ("Di Stéfano" -> "distefano"). */
export function nameKey(s: string): string {
  return normalizeName(s).replace(/ /g, '');
}

interface ScreenIndex {
  full: Set<string>;
  /** surname key -> initials of famous players with that surname. */
  surnameInitials: Map<string, string>;
  iconic: Set<string>;
  /** Iconic keys of 5+ letters (near-miss check). */
  iconicLong: string[];
}

function addSurname(idx: ScreenIndex, key: string, initial: string): void {
  if (key.length === 0) return;
  const prev = idx.surnameInitials.get(key) ?? '';
  if (!prev.includes(initial)) idx.surnameInitials.set(key, prev + initial);
}

function buildIndex(): ScreenIndex {
  const idx: ScreenIndex = { full: new Set(), surnameInitials: new Map(), iconic: new Set(), iconicLong: [] };
  for (const full of FAMOUS_PLAYERS) {
    const words = normalizeName(full).split(' ');
    const initial = words[0]!.charAt(0);
    idx.full.add(words.join(''));
    if (words.length < 2) continue;
    // Whole surname ("vandijk", "alexanderarnold") and each word of it ("dijk", "alexander", "arnold"), so a
    // generated part or particle-less form cannot slip through. Particles (van, de, ...) are skipped.
    addSurname(idx, words.slice(1).join(''), initial);
    for (let i = 1; i < words.length; i++) {
      const w = words[i]!;
      if (!PARTICLES.includes(w)) addSurname(idx, w, initial);
    }
  }
  for (const m of FAMOUS_MONONYMS) idx.iconic.add(nameKey(m));
  for (const s of ICONIC_SURNAMES) idx.iconic.add(nameKey(s));
  for (const k of idx.iconic) if (k.length >= 5) idx.iconicLong.push(k);
  return idx;
}

/** Surname particles that never count as a surname on their own. */
const PARTICLES: readonly string[] = ['van', 'der', 'de', 'den', 'di', 'da', 'do', 'dos', 'das', 'del', 'la', 'le', 'ter', 'mac', 'mc', 'al', 'el', 'ben', 'bin', 'lo', 'st'];

const INDEX = buildIndex();

/** True when a and b differ by at most one insertion, deletion or substitution. */
export function withinOneEdit(a: string, b: string): boolean {
  const la = a.length;
  const lb = b.length;
  if (la - lb > 1 || lb - la > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < la && j < lb) {
    if (a.charCodeAt(i) === b.charCodeAt(j)) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (la > lb) i++;
    else if (lb > la) j++;
    else { i++; j++; }
  }
  return edits + (la - i) + (lb - j) <= 1;
}

/** Split a surname into its parts (hyphens, spaces, apostrophes) as keys, plus the whole-surname key. */
function surnameParts(last: string): string[] {
  const words = normalizeName(last).split(' ').filter((w) => w.length > 0);
  const parts = words.filter((w) => !PARTICLES.includes(w));
  const whole = words.join('');
  if (!parts.includes(whole)) parts.push(whole);
  return parts;
}

/**
 * Screen a candidate name. Returns null when the name is allowed, or the first rule it breaks.
 * `strict` (used by the generator) also rejects any famous surname whatever the initial.
 */
export function screenName(first: string, last: string, strict = false): ScreenHit | null {
  const firstKey = nameKey(first);
  const firstParts = normalizeName(first).split(' ').filter((w) => w.length > 0);
  const lastParts = surnameParts(last);
  const initial = firstKey.charAt(0);

  for (const part of [firstKey, ...firstParts, ...lastParts]) {
    for (const frag of OFFENSIVE_FRAGMENTS) if (part.includes(frag)) return { reason: 'offensive', match: frag };
  }
  const fullKey = firstKey + nameKey(last);
  if (INDEX.full.has(fullKey)) return { reason: 'full', match: fullKey };
  for (const part of [firstKey, ...firstParts, ...lastParts]) {
    if (INDEX.iconic.has(part)) return { reason: 'iconic', match: part };
  }
  for (const part of lastParts) {
    if (part.length < 4) continue;
    for (const ic of INDEX.iconicLong) if (withinOneEdit(part, ic)) return { reason: 'near-iconic', match: ic };
  }
  for (const part of lastParts) {
    const initials = INDEX.surnameInitials.get(part);
    if (initials === undefined) continue;
    if (initials.includes(initial)) return { reason: 'surname-initial', match: part };
    if (strict) return { reason: 'famous-surname', match: part };
  }
  return null;
}

/** Convenience: true when `screenName` finds nothing. */
export function isNameAllowed(first: string, last: string, strict = false): boolean {
  return screenName(first, last, strict) === null;
}

/** Number of distinct famous full names indexed (tests / report). */
export function denylistSize(): number {
  return INDEX.full.size;
}
