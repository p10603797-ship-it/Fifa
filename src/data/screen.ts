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
 *
 * [SGN-05] The originality audit broadened the lists (more legends, World Cup / Euro winners, current players,
 * famous managers who played, women's football; ~1,700 full names). Every addition was checked with
 * `npx tsx tools/gen-data.ts --check` (the committed league is unchanged). A second pass screened every surname the
 * generator can form, and all 360 display names, against Wikidata's footballers and managers (about 98,000 people
 * with 6+ Wikipedia language editions); the famous ones still missing are in AUDIT_FAMOUS_PLAYERS. The famous names
 * the league had already drawn sit in LATE_FAMOUS_PLAYERS / LATE_ICONIC_SURNAMES. `screenShippedName` rejects all of
 * them, `screenName` (the generator's screen) does not, and PLAYER_NAME_FIXES / `applyPlayerNameFixes` rename the
 * committed players that hit the LATE lists without moving any RNG draw.
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
  // ---- SGN-05 extension: Ballon d'Or names, World Cup and Euro winners, club legends (before ~1995)
  'Raymond Kopa', 'Just Fontaine', 'Omar Sivori', 'Josef Masopust', 'Florian Albert', 'Allan Simonsen',
  'Matthias Sammer', 'Tom Finney', 'Nat Lofthouse', 'Billy Wright', 'Duncan Edwards', 'Jimmy Greaves',
  'Johnny Haynes', 'Geoff Hurst', 'Martin Peters', 'Nobby Stiles', 'Alan Ball', 'Roger Hunt', 'Jack Charlton',
  'Ray Wilson', 'George Cohen', 'Ray Clemence', 'Trevor Brooking', 'Bryan Robson', 'Ray Wilkins', 'Glenn Hoddle',
  'John Barnes', 'Chris Waddle', 'Peter Beardsley', 'Stuart Pearce', 'Tony Adams', 'David Platt', 'Paul Ince',
  'Matt Le Tissier', 'Steve McManaman', 'Les Ferdinand', 'Andy Cole', 'Dwight Yorke', 'Jimmy Floyd Hasselbaink',
  'Gianluca Pagliuca', 'Neville Southall', 'Mark Hughes', 'John Charles', 'Ivor Allchurch', 'Gary Speed',
  'Graeme Souness', 'Gordon Strachan', 'Ally McCoist', 'Jimmy Johnstone', 'Jim Baxter', 'Billy McNeill',
  'Billy Bremner', 'Alan Hansen', 'Paul McStay', 'Danny Blanchflower', 'Pat Jennings', 'Liam Brady', 'Paul McGrath',
  'Steve Staunton', 'Ray Houghton', 'John Aldridge', 'Fritz Walter', 'Helmut Rahn', 'Wolfgang Overath', 'Berti Vogts',
  'Uli Hoeness', 'Jupp Heynckes', 'Harald Schumacher', 'Felix Magath', 'Andreas Brehme', 'Jurgen Kohler',
  'Pierre Littbarski', 'Thomas Hassler', 'Bodo Illgner', 'Klaus Augenthaler', 'Guido Buchwald', 'Stefan Reuter',
  'Andreas Moller', 'Bernd Schuster', 'Giuseppe Meazza', 'Silvio Piola', 'Valentino Mazzola', 'Luigi Riva',
  'Gigi Riva', 'Marco Tardelli', 'Bruno Conti', 'Claudio Gentile', 'Gaetano Scirea', 'Antonio Cabrini',
  'Alessandro Altobelli', 'Giuseppe Bergomi', 'Cesare Maldini', 'Roberto Donadoni', 'Demetrio Albertini',
  'Alessandro Costacurta', 'Giuseppe Signori', 'Salvatore Schillaci', 'Fabrizio Ravanelli', 'Roberto Di Matteo',
  'Walter Zenga', 'Johnny Rep', 'Rob Rensenbrink', 'Wim van Hanegem', 'Arie Haan', 'Ronald Koeman', 'Erwin Koeman',
  'Hans van Breukelen', 'Jan Wouters', 'Alain Giresse', 'Jean Tigana', 'Dominique Rocheteau', 'Maxime Bossis',
  'Manuel Amoros', 'Luis Fernandez', 'Mario Coluna', 'Jose Torres', 'Fernando Chalana', 'Vitor Baia', 'Paulo Sousa',
  'Joao Pinto', 'Jan Ceulemans', 'Eric Gerets', 'Marc Wilmots', "Michel Preud'homme", 'Sandor Kocsis',
  'Nandor Hidegkuti', 'Kazimierz Deyna', 'Andrzej Szarmach', 'Gheorghe Popescu', 'Dan Petrescu', 'Krasimir Balakov',
  'Yordan Letchkov', 'Emil Kostadinov', 'Robert Prosinecki', 'Slaven Bilic', 'Robert Jarni', 'Tomas Brolin',
  'Martin Dahlin', 'Thomas Ravelli', 'Glenn Hysen', 'Preben Elkjaer', 'Morten Olsen', 'Flemming Povlsen',
  'Nilton Santos', 'Djalma Santos', 'Mario Zagallo', 'Paulo Roberto Falcao', 'Claudio Taffarel', 'Mauro Silva',
  'Leonardo Araujo', 'Osvaldo Ardiles', 'Ubaldo Fillol', 'Leopoldo Luque', 'Jorge Valdano', 'Jorge Burruchaga',
  'Oscar Ruggeri', 'Sergio Batista', 'Juan Alberto Schiaffino', 'Alcides Ghiggia', 'Obdulio Varela', 'Ruben Sosa',
  'Freddy Rincon', 'Andres Escobar', 'Alberto Spencer', 'Jose Luis Chilavert', 'Carlos Caszely', 'Julio Cesar Romero',
  'Hector Chumpitaz', 'Abedi Ayew', 'Anthony Yeboah', 'Rashidi Yekini', 'Kalusha Bwalya', 'Lakhdar Belloumi',
  'Thomas Nkono', 'Joseph-Antoine Bell', 'Hong Myung-bo', 'Kunishige Kamamoto', 'Ahn Jung-hwan', 'Saeed Al-Owairan',
  'Kasey Keller', 'Claudio Reyna', 'Alexi Lalas', 'Eric Wynalda', 'Jorge Campos', 'Cuauhtemoc Blanco',
  'Jared Borgetti', 'Paulo Wanchope', 'Shaka Hislop', 'Frank Leboeuf', 'Christophe Dugarry', "Stephane Guivarc'h",
  // ---- SGN-05 extension: 1995-2015
  'Marco Materazzi', 'Fabio Grosso', 'Mauro Camoranesi', 'Simone Perrotta', 'Vincenzo Iaquinta', 'Alberto Gilardino',
  'Massimo Oddo', 'Angelo Peruzzi', 'Christian Panucci', 'Joan Capdevila', 'Carlos Marchena', 'Alvaro Arbeloa',
  'Victor Valdes', 'Pepe Reina', 'Fernando Llorente', 'Michel Salgado', 'Ivan Helguera', 'Luis Enrique',
  'Josep Guardiola', 'Ivan de la Pena', 'Joaquin Sanchez', 'Benedikt Howedes', 'Andre Schurrle', 'Julian Draxler',
  'Christoph Kramer', 'Matthias Ginter', 'Roman Weidenfeller', 'Mehmet Scholl', 'Oliver Bierhoff', 'Jens Lehmann',
  'Christian Ziege', 'Jens Jeremies', 'Dietmar Hamann', 'Torsten Frings', 'Bernd Schneider', 'Kevin Kuranyi',
  'Marcel Schmelzer', 'Benjamin Pavard', 'Samuel Umtiti', 'Blaise Matuidi', 'Corentin Tolisso', 'Thomas Lemar',
  'Nabil Fekir', 'Presnel Kimpembe', 'Benjamin Mendy', 'Steven Nzonzi', 'Adil Rami', 'Alphonse Areola',
  'Steve Mandanda', 'Florian Thauvin', 'William Gallas', 'Willy Sagnol', 'Gregory Coupet', 'Eric Abidal',
  'Dimitri Payet', 'Yohan Cabaye', 'Moussa Sissoko', 'Laurent Koscielny', 'Mamadou Sakho', 'Loic Remy',
  'Kevin Gameiro', 'Alexandre Lacazette', 'Anthony Martial', 'Louis Saha', 'Sidney Govou', 'Djibril Sidibe',
  'David Ginola', 'Fabio Coentrao', 'Bruno Alves', 'Renato Sanches', 'William Carvalho', 'Raphael Guerreiro',
  'Cedric Soares', 'Jose Fonte', 'Joao Mario', 'Adrien Silva', 'Ricardo Pereira', 'Nelson Semedo', 'Andre Silva',
  'Angelos Charisteas', 'Theodoros Zagorakis', 'Traianos Dellas', 'Giorgos Karagounis', 'Antonios Nikopolidis',
  'Angelos Basinas', 'Kim Vilfort', 'John Jensen', 'Jon Dahl Tomasson', 'Ebbe Sand', 'Thomas Gravesen', 'Simon Kjaer',
  'Andreas Christensen', 'Thomas Delaney', 'Yussuf Poulsen', 'Mikkel Damsgaard', 'Phillip Cocu', 'Boudewijn Zenden',
  'Giovanni van Bronckhorst', 'Roy Makaay', 'Klaas-Jan Huntelaar', 'John Heitinga', 'Joris Mathijsen', 'Daley Blind',
  'Danny Blind', 'Michael Reiziger', 'Winston Bogarde', 'Pierre van Hooijdonk', 'Eidur Gudjohnsen',
  'Gylfi Sigurdsson', 'Tore Andre Flo', 'John Carew', 'Steffen Iversen', 'Mikael Silvestre', 'Olof Mellberg',
  'Emil Forsberg', 'Zlatko Zahovic', 'Edin Dzeko', 'Miralem Pjanic', 'Vedad Ibisevic', 'Asmir Begovic',
  'Sead Kolasinac', 'Karel Poborsky', 'Patrik Berger', 'Vladimir Smicer', 'Adrian Mutu', 'Cristian Chivu',
  'Serhiy Rebrov', 'Anatoliy Tymoshchuk', 'Andriy Yarmolenko', 'Yevhen Konoplyanka', 'Roman Pavlyuchenko',
  'Igor Akinfeev', 'Yuri Zhirkov', 'Alan Dzagoev', 'Aleksandr Golovin', 'Nihat Kahveci', 'Hamit Altintop',
  'Tugay Kerimoglu', 'Alpay Ozalan', 'Bulent Korkmaz', 'Kamil Glik', 'Arkadiusz Milik', 'Grzegorz Krychowiak',
  'Lukasz Fabianski', 'Didier Zokora', 'Wilfried Bony', 'Serge Aurier', 'Eric Bailly', 'Rigobert Song', 'Alex Song',
  'Patrick Mboma', 'Pierre Webo', 'Eric Maxim Choupo-Moting', 'Vincent Aboubakar', 'Finidi George', 'Daniel Amokachi',
  'Emmanuel Amunike', 'Sunday Oliseh', 'Taribo West', 'Celestine Babayaro', 'Obafemi Martins', 'Ahmed Musa',
  'Odion Ighalo', 'Mahamadou Diarra', 'Adama Traore', 'Steven Pienaar', 'Mohamed Zidan', 'Essam El-Hadary',
  'Sofiane Feghouli', 'Islam Slimani', 'Yacine Brahimi', 'Youssef Chippo', 'Mustapha Hadji', 'Marouane Chamakh',
  'Younes Belhanda', 'Ki Sung-yueng', 'Lee Chung-yong', 'Seol Ki-hyeon', 'Eiji Kawashima', 'Makoto Hasebe',
  'Yuto Nagatomo', 'Takashi Inui', 'Yuya Osako', 'Yasuhito Endo', 'Junichi Inamoto', 'Shinji Ono', 'Naohiro Takahara',
  'Kengo Nakamura', 'Mark Bosnich', 'Lucas Neill', 'Mark Bresciano', 'Aaron Mooy', 'Mathew Leckie', 'Mat Ryan',
  'Ali Karimi', 'Mehdi Mahdavikia', 'Alireza Jahanbakhsh', 'Alireza Beiranvand', 'Hao Haidong', 'Sun Jihai', 'Wu Lei',
  'Ali Mabkhout', 'Almoez Ali', 'Akram Afif', 'Jozy Altidore', 'DaMarcus Beasley', 'Eddie Pope', 'Hector Herrera',
  'Jesus Corona', 'Hector Moreno', 'Miguel Layun', 'Keylor Navas', 'Bryan Ruiz', 'Joel Campbell', 'Atiba Hutchinson',
  'Dwayne De Rosario', 'Ivan Cordoba', 'Mario Yepes', 'Davinson Sanchez', 'Yerry Mina', 'Luis Muriel', 'Duvan Zapata',
  'Cristian Zapata', 'Jefferson Lerma', 'Charles Aranguiz', 'Mauricio Isla', 'Eduardo Vargas', 'Jorge Valdivia',
  'Jean Beausejour', 'David Pizarro', 'Humberto Suazo', 'Claudio Pizarro', 'Jefferson Farfan', 'Paolo Guerrero',
  'Andre Carrillo', 'Christian Cueva', 'Agustin Delgado', 'Ivan Hurtado', 'Antonio Valencia', 'Enner Valencia',
  'Felipe Caicedo', 'Carlos Gamarra', 'Roque Santa Cruz', 'Oscar Cardozo', 'Nelson Valdez', 'Salomon Rondon',
  'Juan Arango', 'Marco Etcheverry', 'Fernando Redondo', 'Roberto Ayala', 'Javier Saviola', 'Diego Milito',
  'Ezequiel Garay', 'Sergio Romero', 'Mauro Icardi', 'Fernando Muslera', 'Paolo Montero', 'Maxi Pereira',
  'Alvaro Pereira', 'Luis Garcia', 'Xabi Prieto', 'Mikel Arteta', 'Emile Heskey', 'Ledley King', 'Owen Hargreaves',
  'Gareth Barry', 'Scott Parker', 'Phil Neville', 'Nicky Butt', 'Wes Brown', 'Darren Fletcher', "John O'Shea",
  'Joe Hart', 'Glen Johnson', 'Darren Bent', 'Kevin Phillips', 'Dion Dublin', 'Chris Sutton', 'Stan Collymore',
  'David James', 'Jamie Redknapp', 'Dennis Wise', 'Ray Parlour', 'Martin Keown', 'Lee Dixon', 'Nigel Winterburn',
  'Steve Bruce', 'Gary Pallister', 'Denis Irwin', 'Leighton Baines', 'Phil Jagielka', 'Seamus Coleman',
  'Kevin Mirallas', 'Ross Barkley', 'Mark Noble', 'Michail Antonio', 'Paolo Di Canio', 'Carlton Cole', 'Wes Morgan',
  'Danny Drinkwater', 'Andy Carroll', 'Daniel Sturridge', 'Adam Lallana', 'Lucas Leiva', 'James Milner', 'Joel Matip',
  'Cesar Azpilicueta', 'Gary Cahill', 'Marcos Alonso', 'Ander Herrera', 'Jesse Lingard', 'Aaron Wan-Bissaka',
  'Mason Greenwood', 'Hector Bellerin', 'Emile Smith Rowe', 'Mousa Dembele', 'Moussa Dembele', 'Christian Benteke',
  'Yannick Carrasco', 'Divock Origi', 'Thomas Meunier', 'Michy Batshuayi', 'Timothy Castagne', 'Radja Nainggolan',
  // ---- SGN-05 extension: current era (2015-2026)
  'Alejandro Balde', 'Fermin Lopez', 'Marc Casado', 'Ansu Fati', 'Joan Garcia', 'Aymeric Laporte', 'Robin Le Normand',
  'Marc Cucurella', 'Alex Baena', 'Dean Huijsen', 'Alvaro Carreras', 'Eder Militao', 'Franco Mastantuono',
  'Marcos Llorente', 'Jose Gimenez', 'Giuliano Simeone', 'Alexander Sorloth', 'Saul Niguez', 'Filipe Luis',
  'Leonardo Spinazzola', 'Giovanni Di Lorenzo', 'Manuel Locatelli', 'Matteo Pessina', 'Domenico Berardi',
  'Emerson Palmieri', 'Federico Bernardeschi', 'Francesco Acerbi', 'Nicolo Zaniolo', 'Mattia Zaccagni',
  'Matteo Politano', 'Stephan El Shaarawy', 'Bryan Cristante', 'Gianluca Mancini', 'Guglielmo Vicario', 'Alex Meret',
  'Salvatore Sirigu', 'Andrea Cambiaso', 'Nahuel Molina', 'Nicolas Tagliafico', 'Marcos Acuna', 'Gonzalo Montiel',
  'Angel Correa', 'German Pezzella', 'Geronimo Rulli', 'Franco Armani', 'Thiago Almada', 'Nicolas Gonzalez',
  'Claudio Echeverri', 'Nico Paz', 'Valentin Barco', 'Leonardo Balerdi', 'Facundo Medina', 'Jonathan Tah',
  'Nico Schlotterbeck', 'David Raum', 'Robert Andrich', 'Maximilian Mittelstadt', 'Deniz Undav',
  'Aleksandar Pavlovic', 'Nick Woltemade', 'Karim Adeyemi', 'Julian Brandt', 'Christopher Nkunku', 'Ibrahima Konate',
  'Youssouf Fofana', 'Wesley Fofana', 'Matteo Guendouzi', 'Jean-Philippe Mateta', 'Hugo Ekitike', 'Maghnes Akliouche',
  'Lucas Digne', 'Ferland Mendy', 'Malo Gusto', 'Lucas Chevalier', 'Brice Samba', 'Manu Kone', 'Joao Palhinha',
  'Francisco Conceicao', 'Sergio Conceicao', 'Francisco Trincao', 'Goncalo Inacio', 'Diogo Dalot', 'Pedro Neto',
  'Danilo Pereira', 'Donyell Malen', 'Wout Weghorst', 'Teun Koopmeiners', 'Micky van de Ven', 'Jurrien Timber',
  'Bart Verbruggen', 'Steven Bergwijn', 'Justin Kluivert', 'Ryan Gravenberch', 'Brian Brobbey', 'Sven Botman',
  'Lois Openda', 'Charles De Ketelaere', 'Senne Lammens', 'Arthur Theate', 'Zeno Debast', 'Amadou Onana',
  'Victor Boniface', 'Samuel Chukwueze', 'Paul Onuachu', 'Moses Simon', 'William Troost-Ekong', 'Joe Aribo',
  'Stanley Nwabali', 'Simon Adingra', 'Evan Ndicka', 'Odilon Kossounou', 'Andre-Frank Zambo Anguissa',
  'Antoine Semenyo', 'Mohammed Salisu', 'Alexander Djiku', 'Pape Matar Sarr', 'Lamine Camara', 'Habib Diarra',
  'Krepin Diatta', 'Mahmoud Trezeguet', 'Ahmed Hegazi', 'Mohamed El Shenawy', 'Ismael Bennacer', 'Ramy Bensebaini',
  'Rayan Ait-Nouri', 'Amine Gouiri', 'Mohamed Amoura', 'Youssef En-Nesyri', 'Sofiane Boufal', 'Noussair Mazraoui',
  'Romain Saiss', 'Azzedine Ounahi', 'Abde Ezzalzouli', 'Nayef Aguerd', 'Eliesse Ben Seghir', 'Ritsu Doan',
  'Junya Ito', 'Ko Itakura', 'Kyogo Furuhashi', 'Ayase Ueda', 'Daizen Maeda', 'Ao Tanaka', 'Zion Suzuki',
  'Hidemasa Morita', 'Hiroki Ito', 'Cho Gue-sung', 'Bae Jun-ho', 'Saud Abdulhamid', 'Moises Caicedo',
  'Piero Hincapie', 'Pervis Estupinan', 'Willian Pacho', 'Kendry Paez', 'Gonzalo Plata', 'Miguel Almiron',
  'Julio Enciso', 'Gustavo Gomez', 'Richard Rios', 'Jhon Arias', 'Daniel Munoz', 'Rafael Borre', 'Mateus Uribe',
  'Wilmar Barrios', 'Jhon Lucumi', 'Yunus Musah', 'Antonee Robinson', 'Sergino Dest', 'Tim Weah', 'Matt Turner',
  'Folarin Balogun', 'Ricardo Pepi', 'Brenden Aaronson', 'Chris Richards', 'Malik Tillman', 'Cyle Larin',
  'Tajon Buchanan', 'Stephen Eustaquio', 'Ismael Kone', 'Milan Borjan', 'Kerem Akturkoglu', 'Ferdi Kadioglu',
  'Orkun Kokcu', 'Merih Demiral', 'Altay Bayindir', 'Filip Kostic', 'Luka Jovic', 'Strahinja Pavlovic',
  'Danijel Subasic', 'Marko Pjaca', 'Ante Rebic', 'Nikola Vlasic', 'Borna Sosa', 'Luka Sucic', 'Martin Baturina',
  'Josip Stanisic', 'Stanislav Lobotka', 'Vladimir Coufal', 'Peter Gulacsi', 'Roland Sallai', 'Artem Dovbyk',
  'Andriy Lunin', 'Viktor Tsygankov', 'Georgiy Sudakov', 'Illia Zabarnyi', 'Sander Berge', 'Antonio Nusa',
  'Oscar Bobb', 'Lukas Hradecky', 'Fredrik Aursnes', 'Anthony Elanga', 'Lucas Bergvall', 'Hugo Larsson',
  'Morten Hjulmand', 'Patrick Dorgu', 'Rasmus Kristensen', 'Joachim Andersen', 'Remo Freuler', 'Breel Embolo',
  'Gregor Kobel', 'Konrad Laimer', 'Marcel Sabitzer', 'Christoph Baumgartner', 'Adam Hlozek', 'Pierre Kalulu',
  'Destiny Udogie', 'Federico Gatti', 'Samuele Ricci', 'Ezri Konsa', 'Levi Colwill', 'Adam Wharton', 'Noni Madueke',
  'Myles Lewis-Skelly', 'Dan Burn', 'Dean Henderson', 'Aaron Ramsdale', 'Ethan Nwaneri', 'Elliot Anderson',
  'Morgan Gibbs-White', 'Jarrad Branthwaite', 'Dominic Calvert-Lewin', 'Dominic Solanke', 'Callum Hudson-Odoi',
  'Trevoh Chalobah', 'Liam Delap', 'Rico Lewis', 'Curtis Jones', 'Harvey Elliott', 'Conor Bradley', 'James Maddison',
  'Harvey Barnes', 'Callum Wilson', 'Nick Pope', 'Tino Livramento', 'Lewis Hall', 'Jacob Murphy', 'Eddie Nketiah',
  'Billy Gilmour', 'Che Adams', 'Craig Gordon', 'Angus Gunn', 'Lewis Ferguson', 'Ben Davies', 'Brennan Johnson',
  'Harry Wilson', 'Daniel James', 'Neco Williams', 'Kieffer Moore', 'Evan Ferguson', 'Caoimhin Kelleher',
  'Nathan Collins', 'Troy Parrott', 'Chiedozie Ogbene', 'Jonny Evans', 'Steven Davis', 'David Healy', 'Pedro Porro',
  'Matheus Cunha', 'Igor Thiago', 'Luiz Henrique', 'Andre Trindade', 'Ederson Moraes', 'Alisson Becker',
  'Jamie Gittens', 'Jobe Bellingham', 'Lewis Miley', 'Leny Yoro', 'Joshua Zirkzee', 'Cristhian Mosquera',
  'Milos Kerkez', 'Vitor Roque',
  // ---- SGN-05 extension: famous managers who were professional players
  'Carlo Ancelotti', 'Antonio Conte', 'Giovanni Trapattoni', 'Marcello Lippi', 'Arrigo Sacchi',
  'Claudio Ranieri', 'Massimiliano Allegri', 'Luciano Spalletti', 'Simone Inzaghi', 'Stefano Pioli',
  'Gian Piero Gasperini', 'Maurizio Sarri', 'Cesare Prandelli', 'Nereo Rocco', 'Helenio Herrera', 'Jose Mourinho',
  'Alex Ferguson', 'Arsene Wenger', 'Jurgen Klopp', 'Joachim Low', 'Ottmar Hitzfeld', 'Hansi Flick',
  'Julian Nagelsmann', 'Thomas Tuchel', 'Rafael Benitez', 'Vicente del Bosque', 'Luis Aragones', 'Unai Emery',
  'Luiz Felipe Scolari', 'Carlos Alberto Parreira', 'Marcelo Bielsa', 'Mauricio Pochettino', 'Cesar Luis Menotti',
  'Carlos Bilardo', 'Rinus Michels', 'Ernst Happel', 'Louis van Gaal', 'Guus Hiddink', 'Dick Advocaat',
  'Erik ten Hag', 'Arne Slot', 'Ruben Amorim', 'Gareth Southgate', 'Roy Hodgson', 'Harry Redknapp', 'Bill Shankly',
  'Bob Paisley', 'Matt Busby', 'Brian Clough', 'Don Revie', 'Alf Ramsey', 'Bobby Robson', 'Terry Venables',
  'Sven-Goran Eriksson', 'Ange Postecoglou', 'Sean Dyche', 'Eddie Howe', 'Steve Clarke', "Martin O'Neill",
  'Gerard Houllier', 'Raymond Domenech', 'Aime Jacquet', 'Hugo Broos', 'Walid Regragui', 'Aliou Cisse',
  'Hajime Moriyasu', 'Herve Renard', 'Luis de la Fuente', 'Lionel Scaloni', 'Marcelo Gallardo', 'Jorge Jesus',
  'Roberto Martinez',
  // ---- SGN-05 extension: women's football
  'Mia Hamm', 'Michelle Akers', 'Kristine Lilly', 'Julie Foudy', 'Brandi Chastain', 'Briana Scurry', 'Abby Wambach',
  'Hope Solo', 'Carli Lloyd', 'Megan Rapinoe', 'Alex Morgan', 'Tobin Heath', 'Christen Press', 'Becky Sauerbrunn',
  'Julie Ertz', 'Crystal Dunn', 'Rose Lavelle', 'Lindsey Horan', 'Sophia Smith', 'Trinity Rodman', 'Mallory Swanson',
  'Naomi Girma', 'Alyssa Naeher', "Kelley O'Hara", 'Sam Mewis', 'Birgit Prinz', 'Nadine Angerer', 'Steffi Jones',
  'Silke Rottenberg', 'Inka Grings', 'Dzsenifer Marozsan', 'Alexandra Popp', 'Lena Oberdorf',
  'Lea Schuller', 'Giulia Gwinn', 'Klara Buhl', 'Merle Frohms', 'Svenja Huth', 'Lina Magull', 'Almuth Schult',
  'Ada Hegerberg', 'Caroline Graham Hansen', 'Maren Mjelde', 'Guro Reiten', 'Frida Maanum', 'Lotta Schelin',
  'Hedvig Lindahl', 'Caroline Seger', 'Kosovare Asllani', 'Fridolina Rolfo', 'Stina Blackstenius',
  'Magdalena Eriksson', 'Nathalie Bjorn', 'Pernille Harder', 'Nadia Nadim', 'Vivianne Miedema', 'Lieke Martens',
  'Sherida Spitse', 'Danielle van de Donk', 'Jackie Groenen', 'Lineth Beerensteyn', 'Jill Roord', 'Lucy Bronze',
  'Kelly Smith', 'Steph Houghton', 'Fara Williams', 'Jill Scott', 'Ellen White', 'Karen Carney', 'Alex Scott',
  'Eniola Aluko', 'Rachel Yankey', 'Beth Mead', 'Leah Williamson', 'Millie Bright', 'Mary Earps', 'Alessia Russo',
  'Lauren James', 'Lauren Hemp', 'Chloe Kelly', 'Georgia Stanway', 'Keira Walsh', 'Ella Toone', 'Rachel Daly',
  'Hannah Hampton', 'Fran Kirby', 'Nikita Parris', 'Bethany England', 'Jordan Nobbs', 'Wendie Renard',
  'Amandine Henry', 'Eugenie Le Sommer', 'Delphine Cascarino', 'Kadidiatou Diani', 'Marie-Antoinette Katoto',
  'Sakina Karchaoui', 'Grace Geyoro', 'Selma Bacha', 'Louisa Necib', 'Camille Abily', 'Sarah Bouhaddi',
  'Gaetane Thiney', 'Alexia Putellas', 'Aitana Bonmati', 'Jennifer Hermoso', 'Irene Paredes', 'Mapi Leon',
  'Patri Guijarro', 'Salma Paralluelo', 'Olga Carmona', 'Ona Batlle', 'Mariona Caldentey', 'Cata Coll',
  'Claudia Pina', 'Sam Kerr', 'Ellie Carpenter', 'Caitlin Foord', 'Mary Fowler', 'Steph Catley', 'Hayley Raso',
  'Mackenzie Arnold', 'Lisa De Vanna', 'Christine Sinclair', 'Kadeisha Buchanan', 'Ashley Lawrence', 'Jessie Fleming',
  'Janine Beckie', 'Stephanie Labbe', 'Homare Sawa', 'Saki Kumagai', 'Mana Iwabuchi', 'Yuki Nagasato', 'Aya Miyama',
  'Hinata Miyazawa', 'Asisat Oshoala', 'Perpetua Nkwocha', 'Barbra Banda', 'Thembi Kgatlana', 'Rasheedat Ajibade',
  'Chiamaka Nnadozie', 'Sun Wen', 'Wang Shuang', 'So-yun Ji', 'Barbara Bonansea', 'Cristiana Girelli', 'Sara Gama',
  'Manuela Giugliano', 'Ramona Bachmann', 'Lia Walti', 'Tessa Wullaert', 'Linda Caicedo', 'Mayra Ramirez',
  'Christiane Endler',
];

/** Famous one-name players: rejected as ANY name part. */
export const FAMOUS_MONONYMS: readonly string[] = [
  'Pele', 'Eusebio', 'Garrincha', 'Zico', 'Socrates', 'Romario', 'Rivaldo', 'Ronaldinho', 'Ronaldo', 'Kaka',
  'Cafu', 'Bebeto', 'Dida', 'Adriano', 'Robinho', 'Juninho', 'Deco', 'Neymar', 'Marcelo', 'Casemiro',
  'Fernandinho', 'Fabinho', 'Jorginho', 'Oscar', 'Willian', 'Hulk', 'Fred', 'Alisson', 'Ederson', 'Raphinha',
  'Rodrygo', 'Antony', 'Endrick', 'Richarlison', 'Vitinha', 'Pepe', 'Nani', 'Xavi', 'Isco', 'Pedri', 'Gavi',
  'Rodri', 'Koke', 'Careca', 'Denilson', 'Lucio', 'Rafinha', 'Savinho', 'Gervinho', 'Jairzinho', 'Rivelino',
  'Tostao', 'Kanu', 'Falcao',
  // SGN-05 extension
  'Didi', 'Vava', 'Gerson', 'Clodoaldo', 'Dunga', 'Branco', 'Aldair', 'Mazinho', 'Taffarel', 'Kleberson', 'Edmilson',
  'Ramires', 'Marquinhos', 'Militao', 'Joelinton', 'Estevao', 'Pauleta', 'Maniche', 'Tite', 'Guti', 'Joselu',
  'Juanfran', 'Luisao', 'Elano', 'Nilmar', 'Maicon', 'Paulinho', 'Formiga', 'Marta', 'Cristiane', 'Debinha',
  'Kerolin', 'Geyse', 'Zagallo', 'Leonidas', 'Ademir', 'Friedenreich',
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
  // SGN-05 extension
  'Ancelotti', 'Mourinho', 'Guardiola', 'Klopp', 'Wenger', 'Trapattoni', 'Garrincha', 'Kempes',
  'Passarella', 'Francescoli', 'Forlan', 'Suker', 'Blokhin', 'Boniek', 'Scirea', 'Facchetti', 'Meazza', 'Del Piero',
  'Inzaghi', 'Makelele', 'Deschamps', 'Desailly', 'Ballack', 'Klose', 'Hummels', 'Baresi', 'Vialli', 'Tardelli',
  'Dasayev', 'Odegaard', 'Osimhen', 'Dybala', 'Higuain', 'Tevez', 'Mascherano', 'Di Maria', 'Hegerberg', 'Putellas',
  'Bonmati', 'Rapinoe', 'Miedema', 'Masopust', 'Sivori', 'Seeler', 'Lofthouse',
];

/** Fragments that must never appear inside a generated name part (letters only, lowercase). */
export const OFFENSIVE_FRAGMENTS: readonly string[] = [
  'fuck', 'shit', 'cunt', 'nigg', 'nigr', 'fag', 'rape', 'nazi', 'hitler', 'porn', 'slut', 'whore', 'piss', 'cock',
  'dick', 'twat', 'wank', 'bitch', 'penis', 'vagin', 'anus', 'arse', 'kkk', 'jizz', 'tits', 'boob', 'homo',
  'retard', 'spic', 'kike', 'chink', 'gook', 'paki', 'coon', 'dyke', 'tranny', 'wog', 'wop', 'slag', 'bollock',
  'bastard', 'crap', 'turd', 'poop', 'sex', 'nude', 'kill', 'dead', 'satan', 'semen', 'scum', 'idiot', 'moron',
  // SGN-05: infamous names the syllable lists could form ("Cap" + "one")
  'capone', 'stalin', 'mussolini', 'pinochet', 'goebbels', 'himmler', 'mengele',
];

/**
 * [SGN-05] Famous players added by the originality audit whose surname the committed league had already drawn. They
 * are screened like FAMOUS_PLAYERS / ICONIC_SURNAMES by `screenShippedName` (tests, tools/gen-data.ts validation) but
 * not by `screenName`, which the generator calls: a redraw there would shift that club's RNG stream and re-roll the
 * attributes of every later player in the squad. Instead the generated names that hit them are replaced after
 * generation from PLAYER_NAME_FIXES (names only; attributes, kits and every other name stay identical).
 * Rule for later additions: a famous name goes into FAMOUS_PLAYERS (or the other lists) when
 * `npx tsx tools/gen-data.ts --check` stays OK with it; only one that hits a committed name goes here, with a fix.
 */
export const LATE_FAMOUS_PLAYERS: readonly string[] = ['Fabio Capello', 'Celia Sasic', 'Willie Thornton'];

/**
 * Iconic surnames added the same way (any initial, and one-edit near-misses of 5+ letters). Zanetti (Javier Zanetti,
 * Inter and Argentina) is as iconic as the Mascherano / Tevez tier of ICONIC_SURNAMES; the league had drawn "Zanotti".
 */
export const LATE_ICONIC_SURNAMES: readonly string[] = ['Capello', 'Zanetti'];

/**
 * [SGN-05 second pass] Famous footballers whose surname the generator can form: playerGen's whole surname space
 * (every lastA x lastB of every origin, ~2,400) screened against Wikidata's footballers and managers with 20+ Wikipedia
 * language editions. The committed league uses none of them. They are screened by `screenShippedName` only, not by the
 * generator's `screenName`: there they would also reject candidates drawn for other seeds, which moves DAT-02's
 * sample statistics (tests/unit/dat-02-playergen.test.ts) although the shipped league stays the same. If a
 * regeneration ever draws one, the SGN-05 tests fail; then give it a PLAYER_NAME_FIXES entry, or move the list into
 * FAMOUS_PLAYERS together with a DAT-02 re-baseline.
 */
export const AUDIT_FAMOUS_PLAYERS: readonly string[] = [
  'Naoki Matsuda', 'Hiroaki Morishima', 'Paulo Ferreira', 'Kazuya Yamamura', 'Jungo Fujimoto', 'Taizo Kawamoto',
  'Masakuni Yamamoto', 'Ikuo Matsumoto', 'Naohiro Ishikawa', 'Kazumi Takada', 'Naoki Yamada', 'Nobuo Fujishima',
  'Tomislav Maric', 'Junji Kawano', 'Kuniharu Nakamoto', 'Heinz Lindner', 'Roberto Rosato', 'Ramazan Ozcan',
  'Takaya Kurokawa', 'Julien Faubert', 'Dean Ashton', 'Lennart Skoglund', 'Michael Beauchamp', 'Gianpiero Marini',
  'Naoki Ishihara', 'Takahiro Kawamura', 'Kazuhisa Kawahara', 'Takayuki Fujikawa', 'Takahiro Shimada',
  'Aymore Moreira', 'Takeo Harada', 'Dorlan Pabon', 'Hiroyuki Ishida', 'Yuki Nakashima', 'Takao Yamauchi',
  'Tomoaki Matsukawa', 'Emma Berglund', 'Hiroshi Nakano', 'Kenta Hoshihara', 'Rabah Saadane', 'Jose Carlos Serrao',
  'Theodore Whitmore', 'Kota Morimura', 'Hitoshi Matsushima', 'Masashi Shimamura', 'Bruno Berner', 'Abdullah Ercan',
  'Torsten Lindberg', 'Reinhard Hafner', 'Kenji Nakada', 'Gabriel Paletta',
];

/** A generated display name replaced after generation: club id, the generated name, its replacement. */
export interface PlayerNameFix {
  club: number;
  from: string;
  to: string;
}

/**
 * Replacements for the committed names that collide with LATE_FAMOUS_PLAYERS / LATE_ICONIC_SURNAMES (same origin
 * syllables as the generator; each passes `screenShippedName` and is unique in the league). Applied by
 * `applyPlayerNameFixes` right after each squad is generated.
 */
export const PLAYER_NAME_FIXES: readonly PlayerNameFix[] = [
  { club: 10, from: 'G. Sašić', to: 'G. Vulak' }, // Célia Šašić (2015 World Cup Golden Boot)
  { club: 16, from: 'O. Capello', to: 'O. Nerozzi' }, // Fabio Capello (Italy, Roma, Juventus, Milan; England manager)
  // SGN-05 second pass (Wikidata screen of all 360 display names):
  { club: 14, from: 'S. Zanotti', to: 'S. Rosaldi' }, // one letter from Javier Zanetti (Inter, Argentina)
  { club: 19, from: 'W. Thornton', to: 'W. Hartcroft' }, // Willie Thornton (Rangers and Scotland centre-forward)
  // Lead, from the second pass's advisory list:
  { club: 14, from: 'G. Paletti', to: 'G. Tolvane' }, // one letter from Gabriel Paletta (same initial)
  { club: 16, from: 'D. Mabuza', to: 'D. Merrow' }, // display name of David Mabuza (former Deputy President of South Africa)
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

interface LateIndex {
  full: Set<string>;
  /** Surname keys (whole surname and each non-particle word). */
  surnames: Set<string>;
  iconic: Set<string>;
  iconicLong: string[];
}

function buildLateIndex(): LateIndex {
  const idx: LateIndex = { full: new Set(), surnames: new Set(), iconic: new Set(), iconicLong: [] };
  for (const full of [...LATE_FAMOUS_PLAYERS, ...AUDIT_FAMOUS_PLAYERS]) {
    const words = normalizeName(full).split(' ');
    idx.full.add(words.join(''));
    if (words.length < 2) continue;
    idx.surnames.add(words.slice(1).join(''));
    for (let i = 1; i < words.length; i++) if (!PARTICLES.includes(words[i]!)) idx.surnames.add(words[i]!);
  }
  for (const s of LATE_ICONIC_SURNAMES) idx.iconic.add(nameKey(s));
  for (const k of idx.iconic) if (k.length >= 5) idx.iconicLong.push(k);
  return idx;
}

const LATE_INDEX = buildLateIndex();

/**
 * [SGN-05] Screen a name as shipped: `screenName` in strict mode, then the LATE_* and AUDIT_* lists (full name, iconic
 * surname in any part, one-edit near-miss of a 5+ letter iconic surname, any listed famous surname whatever the
 * initial). `first` may be just the initial of a committed display name. Returns null when the name may ship.
 */
export function screenShippedName(first: string, last: string): ScreenHit | null {
  const hit = screenName(first, last, true);
  if (hit !== null) return hit;
  const firstParts = normalizeName(first).split(' ').filter((w) => w.length > 0);
  const lastParts = surnameParts(last);
  const fullKey = nameKey(first) + nameKey(last);
  if (LATE_INDEX.full.has(fullKey)) return { reason: 'full', match: fullKey };
  for (const part of [...firstParts, ...lastParts]) {
    if (LATE_INDEX.iconic.has(part)) return { reason: 'iconic', match: part };
  }
  for (const part of lastParts) {
    if (part.length < 4) continue;
    for (const ic of LATE_INDEX.iconicLong) if (withinOneEdit(part, ic)) return { reason: 'near-iconic', match: ic };
  }
  for (const part of lastParts) if (LATE_INDEX.surnames.has(part)) return { reason: 'famous-surname', match: part };
  return null;
}

/**
 * [SGN-05] Replace the PLAYER_NAME_FIXES names of club `clubId` in a freshly generated squad (display name and short
 * name; nothing else changes and no RNG is drawn). Returns how many players were renamed.
 */
export function applyPlayerNameFixes(clubId: number, squad: { name: string; short: string }[]): number {
  let n = 0;
  for (const f of PLAYER_NAME_FIXES) {
    if (f.club !== clubId) continue;
    for (const p of squad) {
      if (p.name !== f.from) continue;
      p.name = f.to;
      p.short = f.to.slice(f.to.indexOf('. ') + 2);
      n++;
    }
  }
  return n;
}
