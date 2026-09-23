# Komunitní pomoc

Čtěte, když:
- chcete vysvětlit dobrovolníkům, jak mohou pomáhat s kontrolou fotografií
- potřebujete připomenout rozdíl mezi opravou polohy, kontrolou podobných záběrů a kontrolou skupin
- připravujete text pro uživatelskou nápovědu nebo veřejný popis projektu

Tento text je uživatelský průvodce. Technické detaily pro správce a vývojáře
jsou v dokumentu [Community Help Workflows](./community-voting.md).

## O co jde

Projekt zobrazuje historické fotografie Prahy na mapě. Část poloh a skupin je
vytvořená automaticky z archivních metadat, takže některé výsledky mohou být
nepřesné. Komunitní pomoc slouží k tomu, aby lidé mohli jednoduše označit:

- jestli poloha fotografie na mapě sedí
- jestli dvě podobné skupiny patří k sobě (stejná fotografie nebo stejné focení)
- jestli skupina verzí a skenů vypadá jako jedna smysluplná série

Tyto tři věci spolu souvisejí, ale nejsou stejné. Proto mají v aplikaci tři
samostatné režimy.

## Rychlý přehled režimů

Na mapě vede do komunitní kontroly tlačítko "Chcete pomoct?". Otevře rovnou
opravu polohy, protože je nejjednodušší. Ostatní režimy najdete pod odkazem
"Vybrat jiný úkol".

### Oprava polohy

Stránka:
- `/pomoc.html?mode=location`

Řeší otázku:
- Sedí bod na mapě s místem na fotografii?

Použijte, když chcete zkontrolovat nebo opravit polohu fotografie.

### Kontrola podobných záběrů

Stránka:
- `/dup-review.html`

Řeší otázku:
- Patří tyto dvě skupiny k sobě?

Použijte, když chcete slučovat duplicitní záznamy nebo záběry ze stejného
focení, které se dostaly do různých skupin.

### Kontrola skupin

Stránka:
- `/group-review.html`

Řeší otázku:
- Patří fotografie v této skupině k sobě?

Použijte, když chcete zkontrolovat, že skupina vytvořená z metadat nemíchá různé
záběry, místa nebo nesouvisející verze.

## Důležité pravidlo

Každý režim ukládá jiný typ pomoci.

Když v kontrole skupin kliknete na "Skupina je správně", říkáte jen to, že
fotografie v této skupině patří k sobě. Neříkáte tím, že poloha na mapě je
správně.

Když v opravě polohy kliknete na "Poloha sedí", říkáte jen to, že poloha na mapě je
správně. Neříkáte tím, že fotografie nejsou duplicitní nebo že skupina je dobře
sestavená.

Toto oddělení je záměrné. Pomáhá zabránit tomu, aby jeden typ kontroly omylem
potvrdil něco jiného.

## Než začnete

Nemusíte být odborník na historii Prahy. Pomůže i opatrná kontrola podle toho,
co je na fotografii vidět.

Doporučený postup:

1. Prohlédněte fotografii nebo sken.
2. Přečtěte si popis, dataci, autora a signaturu.
3. Pokud je potřeba, otevřete archivní stránku.
4. Rozhodněte jen tehdy, když si jste rozumně jistí.
5. Pokud si nejste jistí, raději přeskočte nebo použijte volbu "Nevím, kde to je".

Při prvním uložení se může objevit ověření, že nejste robot. Ověření platí pro
relaci, takže by se nemělo objevovat při každém jednom kliknutí.

Tlačítka pro rozhodnutí jsou ve všech režimech ve spodní liště, která zůstává
na obrazovce i při posouvání stránky. Na počítači můžete používat klávesy:

- `A` – ano (poloha sedí / sloučit skupiny / skupina je správně)
- `N` – ne (poloha nesedí / ponechat skupiny zvlášť / skupina míchá různé fotografie)
- `→` – přeskočit na další
- `←` – vrátit se na předchozí

Počítadlo "Vaše kontroly" v záhlaví ukazuje, kolik rozhodnutí jste uložili
během této návštěvy.

## Režim 1: Oprava polohy

Tento režim ukáže fotografii, její popis a bod na mapě vedle sebe.

### Kdy kliknout na "Poloha sedí"

Klikněte na "Poloha sedí", když poloha na mapě odpovídá místu na fotografii.

Typické příklady:
- na fotografii je dům, ulice, most, náměstí nebo památka a bod na mapě leží na správném místě
- popis z archivu odpovídá poloze na mapě
- fotografie může být stará nebo z jiného úhlu, ale místo jako takové sedí

Kliknutím potvrzujete polohu celé série, ne jen právě zobrazeného skenu.

Pokud už někdo navrhl opravu, mapa ukáže současný i navržený bod a tlačítko se
změní na "Potvrdit návrh". Kliknutím schválíte navržený bod.

### Kdy kliknout na "Poloha nesedí"

Klikněte na "Poloha nesedí", když je bod na mapě zjevně špatně.

Potom máte dvě možnosti:

- pokud správné místo znáte, klikněte do mapy na správnou polohu a uložte opravu
  tlačítkem "Uložit opravu"
- pokud víte, že poloha nesedí, ale neumíte ji přesně určit, použijte "Nevím, kde to je"

Opravu můžete poslat i přímo z mapy: otevřete fotografii, klikněte na "Opravit
polohu" a přesuňte špendlík na správné místo.

Do poznámky můžete napsat krátké vysvětlení, například:
- "Má být u Národního divadla, ne na druhém břehu."
- "Popis odpovídá Vodičkově ulici."
- "Současná poloha je jen přibližná, přesný dům si nejsem jistý."

E-mail je volitelný. Uloží se spolu s hlášením pro případné upřesnění, veřejně
se nezobrazuje a web si ho neukládá pro další hlášení.

### Kdy použít "Přeskočit"

Použijte "Přeskočit", když:
- si nejste jistí
- fotografie nemá dost detailů
- archivní popis nestačí
- nechcete o tomto záznamu rozhodovat

Přeskočení nic neukládá.

### Na co si dát pozor

Neopravujte polohu jen podle dnešní podoby místa, pokud si nejste jistí.
Historická Praha se hodně měnila. U zbořených domů, přejmenovaných ulic nebo
starších nábřeží je lepší být opatrný.

Neřešte v tomto režimu, jestli jsou dvě fotografie duplicitní. K tomu slouží
"Kontrola podobných záběrů".

## Režim 2: Kontrola podobných záběrů

Tento režim ukáže dvě skupiny vedle sebe. Cílem je rozhodnout, jestli patří k
sobě, tedy jestli by měly být jednou skupinou.

Skupina je série fotografií, které spolu souvisejí: stejná fotografie v různých
skenech a také různé záběry ze stejného focení. Sloučit proto můžete i dvě
fotografie, které nejsou úplně stejné, pokud zjevně vznikly při jedné
příležitosti.

Dvojice se do fronty dostávají hlavně proto, že:
- mají stejnou nebo velmi podobnou polohu
- vypadají vizuálně podobně podle automatického porovnání

### Kdy kliknout na "Sloučit skupiny"

Klikněte na "Sloučit skupiny", když obě strany ukazují tutéž fotografii nebo
záběry ze stejného focení.

Typicky jde o:
- jeden sken světlejší nebo tmavší
- jeden sken oříznutý
- mírně pootočený obraz
- pozitiv a negativ téhož snímku
- jiný sken stejné archivní fotografie
- další záběr stejného fotografa, ze stejného dne a stejného místa

### Kdy kliknout na "Ponechat skupiny zvlášť"

Klikněte na "Ponechat skupiny zvlášť", když skupiny nemají být sloučené.

Typické příklady:
- stejná ulice, ale jiný dům nebo jiná část ulice
- podobné téma, ale jiná událost
- stejná stavba, ale fotografie z jiného roku nebo od jiného autora
- fotografie z různých focení, i když jsou si podobné

Stejná poloha na mapě sama o sobě nestačí ke sloučení. Pomůže porovnat autora
a dataci v údajích pod fotografiemi.

### Kdy použít "Další pár"

Použijte "Další pár", když si nejste jistí. Je lepší pár přeskočit než uložit
špatné sloučení.

### Kdy použít "Zpět"

Použijte "Zpět" pod tlačítky, pokud jste si hned po kliknutí uvědomili, že jste
rozhodli špatně. Vrací se poslední rozhodnutí v aktuálním prohlížeči.

### Jak kontrolovat pečlivěji

Pomáhá porovnat:
- tvar střech, oken a fasád
- polohu stromů, lamp, kolejí, mostů nebo reklam
- autora, dataci, signaturu a popis
- další verze ve stejné skupině

Pokud jedna strana obsahuje více verzí, zkuste mezi nimi přepnout v údajích
pod fotografií. Někdy je shoda jasná až u jiné verze nebo skenu.

## Režim 3: Kontrola skupin

Tento režim ukazuje jednu skupinu fotografií. Skupiny vznikají z metadat, hlavně
podle popisu, autora a datace. Cílem je ověřit, že fotografie ve skupině opravdu
patří k sobě.

Nad velkým náhledem je řada miniatur všech fotografií ve skupině. Kliknutím na
miniaturu ji zobrazíte ve velkém náhledu.

### Kdy kliknout na "Skupina je správně"

Klikněte, když skupina působí vnitřně souvisle.

Typické příklady:
- několik skenů stejné fotografie
- pozitiv a negativ stejného záběru
- více verzí jedné archivní položky
- různé záběry ze stejného focení
- jedna série detailů nebo variant, které podle popisu a obrazu patří k sobě

Kliknutím neříkáte nic o poloze na mapě. Potvrzujete jen kvalitu skupiny.
Skupina se považuje za zkontrolovanou, když ji potvrdí dva různí lidé.

### Kdy kliknout na "Skupina míchá různé fotografie"

Klikněte, když skupina:
- obsahuje různé nesouvisející záběry
- má verzi, která zjevně patří jinam
- spojuje stejným popisem více různých míst

Když to takto označí dva různí lidé, skupina se dostane ke kurátorovi, který ji
rozdělí.

Pokud si nejste jistí, skupinu raději přeskočte tlačítkem "Další skupina", nebo
otevřete "Porovnat s podobnými". Tím přejdete do kontroly podobných záběrů
zaměřené na danou skupinu.

### Co znamená "Zobrazit znovu prošlé"

Toto tlačítko najdete úplně dole na stránce. Maže jen lokální filtr ve vašem
prohlížeči. Neodstraňuje hlasy, které už byly uložené na server.

Použijte ho, když chcete znovu procházet série, které jste v tomto prohlížeči už
odklikli.

## Jak se počítá komunitní potvrzení

Aplikace se snaží nepočítat opakované klikání jednoho člověka jako víc
nezávislých potvrzení.

Prakticky to znamená:
- dva lidé mohou společně potvrdit položku rychleji než jeden člověk opakovaným klikáním
- u některých stavů je potřeba víc než jeden nezávislý hlas
- po nové opravě se starší potvrzení nemusí počítat pro novou situaci

Nemusíte si pamatovat přesná pravidla. Důležité je rozhodovat poctivě a
neklikat opakovaně jen proto, aby něco zmizelo z fronty.

## Co se ukládá

Na server se ukládají:
- potvrzení nebo opravy polohy
- rozhodnutí, jestli se mají dvě skupiny sloučit
- potvrzení, že skupina je správně, nebo návrh ji rozdělit

V prohlížeči se navíc může ukládat:
- seznam skupin, které se vám dočasně nemají znovu ukazovat v kontrole skupin

Tento lokální seznam je jen pohodlí pro práci. Není to hlavní databáze projektu.

## Když si nejste jistí

Nejlepší pravidlo je: nejisté věci raději nepřepalovat.

Použijte:
- "Přeskočit" v opravě polohy
- "Nevím, kde to je", když víte, že poloha je špatně, ale neznáte správný bod
- "Další pár" v kontrole podobných záběrů
- "Další skupina" nebo "Porovnat s podobnými", když skupina vypadá podezřele

I přeskočení je užitečné, protože snižuje riziko špatných oprav.

## Příklady rozhodování

### Příklad: stejná fotografie, jiný sken

Obě strany ukazují stejný dům ze stejného úhlu. Jedna je tmavší a druhá má jiný
ořez.

V kontrole podobných záběrů zvolte:
- "Sloučit skupiny"

### Příklad: dva záběry ze stejného focení

Obě fotografie pořídil stejný fotograf ve stejný den na stejném místě. Jedna
míří na dům zepředu, druhá zboku.

V kontrole podobných záběrů zvolte:
- "Sloučit skupiny"

### Příklad: stejná ulice, jiné focení

Obě fotografie jsou ve stejné ulici, ale každá je od jiného autora a z jiného
roku.

V kontrole podobných záběrů zvolte:
- "Ponechat skupiny zvlášť"

### Příklad: poloha je zjevně o ulici vedle

Fotografie podle popisu i obrazu ukazuje konkrétní dům, ale bod na mapě leží ve
vedlejší ulici.

V opravě polohy zvolte:
- "Poloha nesedí"
- klikněte do mapy na správné místo
- přidejte krátkou poznámku

### Příklad: skupina míchá dvě věci

Ve skupině jsou dvě fotografie stejného náměstí, ale třetí položka ukazuje jinou
ulici.

V kontrole skupin zvolte:
- "Skupina míchá různé fotografie"

## Časté potíže

### Ověření se zobrazilo znovu

To se může stát po delší době, v jiném prohlížeči, při smazání cookies nebo při
nové relaci. Dokončete ověření a pokračujte.

### Archivní stránka se nenačítá

Archiv může být pomalý nebo dočasně nedostupný. Zkuste to později nebo položku
přeskočte.

### Na mapě se mi těžko vybírá přesný bod

Přibližte mapu a klikněte co nejpřesněji. Pokud si přesným bodem nejste jistí,
raději použijte "Nevím, kde to je" a doplňte poznámku.

### Už se mi nic neukazuje

Může to znamenat, že pro vás momentálně nezbývá nic dalšího. V kontrole skupin
můžete použít "Zobrazit znovu prošlé" dole na stránce, což obnoví jen lokální
seznam v tomto prohlížeči.

## Shrnutí

- Oprava polohy říká, jestli sedí bod na mapě.
- Kontrola podobných záběrů říká, jestli se mají dvě skupiny sloučit.
- Kontrola skupin říká, jestli jedna skupina vypadá vnitřně správně.

Když budete tyto tři otázky držet odděleně, vaše pomoc bude pro projekt
nejužitečnější.
