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
- jestli jsou dva podobné záběry opravdu totéž
- jestli skupina verzí a skenů vypadá jako jedna smysluplná série

Tyto tři věci spolu souvisejí, ale nejsou stejné. Proto mají v aplikaci tři
samostatné režimy.

## Rychlý přehled režimů

### Oprava polohy

Stránka:
- `/pomoc.html`

Řeší otázku:
- Je špendlík na mapě na správném místě?

Použijte, když chcete zkontrolovat nebo opravit polohu fotografie.

### Kontrola podobných záběrů

Stránka:
- `/dup-review.html`

Řeší otázku:
- Jsou tyto dvě skupiny fotografií ve skutečnosti stejný záběr nebo stejná série?

Použijte, když chcete slučovat duplicitní nebo velmi podobné záznamy.

### Kontrola skupin

Stránka:
- `/group-review.html`

Řeší otázku:
- Patří fotografie v této skupině k sobě?

Použijte, když chcete zkontrolovat, že skupina vytvořená z metadat nemíchá různé
záběry, místa nebo nesouvisející verze.

## Důležité pravidlo

Každý režim ukládá jiný typ pomoci.

Když v kontrole skupin kliknete na "Série vypadá dobře", říkáte jen to, že
fotografie v této skupině patří k sobě. Neříkáte tím, že poloha na mapě je
správně.

Když v opravě polohy kliknete na "Sedí", říkáte jen to, že poloha na mapě je
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
5. Pokud si nejste jistí, raději přeskočte nebo použijte volbu "nevím kde přesně".

Při prvním uložení se může objevit ověření, že nejste robot. Ověření platí pro
relaci, takže by se nemělo objevovat při každém jednom kliknutí.

## Režim 1: Oprava polohy

Tento režim porovnává fotografii s bodem na mapě.

### Kdy kliknout na "Sedí"

Klikněte na "Sedí", když poloha na mapě odpovídá místu na fotografii.

Typické příklady:
- na fotografii je dům, ulice, most, náměstí nebo památka a bod na mapě leží na správném místě
- popis z archivu odpovídá poloze na mapě
- fotografie může být stará nebo z jiného úhlu, ale místo jako takové sedí

Kliknutím potvrzujete polohu celé série, ne jen právě zobrazeného skenu.

### Kdy kliknout na "Nesedí"

Klikněte na "Nesedí", když je bod na mapě zjevně špatně.

Potom máte dvě možnosti:

- pokud správné místo znáte, klikněte do mapy na správnou polohu a uložte opravu
- pokud víte, že poloha nesedí, ale neumíte ji přesně určit, použijte "Nevím kde přesně"

Do poznámky můžete napsat krátké vysvětlení, například:
- "Má být u Národního divadla, ne na druhém břehu."
- "Popis odpovídá Vodičkově ulici."
- "Současná poloha je jen přibližná, přesný dům si nejsem jistý."

E-mail je volitelný. Slouží jen pro případ, že chcete být kontaktováni nebo se
přihlásit k dalším informacím.

### Kdy použít "Další fotka"

Použijte "Další fotka", když:
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

Tento režim ukáže dvě skupiny vedle sebe. Cílem je rozhodnout, jestli jde o
stejný záběr nebo o různé záběry.

Dvojice se do fronty dostávají hlavně proto, že:
- mají stejnou nebo velmi podobnou polohu
- vypadají vizuálně podobně podle automatického porovnání

### Kdy kliknout na "Stejný záběr"

Klikněte na "Stejný záběr", když obě strany ukazují tentýž záběr nebo stejnou
sérii.

Může jít o stejný záběr i tehdy, když:
- jeden sken je světlejší nebo tmavší
- jeden sken je oříznutý
- obraz je mírně pootočený
- jde o pozitiv a negativ téhož snímku
- jde o jiný sken stejné archivní fotografie

### Kdy kliknout na "Různé záběry"

Klikněte na "Různé záběry", když fotografie nemají být sloučené.

Typické příklady:
- stejné místo, ale jiný úhel pohledu
- stejná ulice, ale jiný dům nebo jiná část ulice
- podobné téma, ale jiná událost
- stejná stavba, ale zjevně jiný snímek nebo jiný čas

Stejná poloha na mapě sama o sobě nestačí ke sloučení.

### Kdy použít "Další pár"

Použijte "Další pár", když si nejste jistí. Je lepší pár přeskočit než uložit
špatné sloučení.

### Kdy použít "Vrátit poslední hlas"

Použijte "Vrátit poslední hlas", pokud jste si hned po kliknutí uvědomili, že
jste rozhodli špatně. Vrací se poslední rozhodnutí v aktuálním prohlížeči.

### Jak kontrolovat pečlivěji

Pomáhá porovnat:
- tvar střech, oken a fasád
- polohu stromů, lamp, kolejí, mostů nebo reklam
- signaturu a popis
- dataci
- další verze ve stejné skupině

Pokud jedna strana obsahuje více verzí, zkuste mezi nimi přepnout. Někdy je
shoda jasná až u jiné verze nebo skenu.

## Režim 3: Kontrola skupin

Tento režim ukazuje jednu skupinu fotografií. Skupiny vznikají z metadat, hlavně
podle popisu, autora a datace. Cílem je ověřit, že fotografie ve skupině opravdu
patří k sobě.

### Kdy kliknout na "Série vypadá dobře"

Klikněte, když skupina působí vnitřně souvisle.

Typické příklady:
- několik skenů stejné fotografie
- pozitiv a negativ stejného záběru
- více verzí jedné archivní položky
- jedna série detailů nebo variant, které podle popisu a obrazu patří k sobě

Kliknutím neříkáte nic o poloze na mapě. Potvrzujete jen kvalitu skupiny.

### Kdy skupinu nepotvrzovat

Skupinu nepotvrzujte, když:
- obsahuje různé nesouvisející záběry
- některá verze zjevně patří jinam
- stejný popis spojil více různých míst
- si nejste jistí, jestli položky opravdu patří dohromady

V takovém případě můžete otevřít "Prověřit v párovém porovnání". Tím přejdete
do kontroly podobných záběrů zaměřené na danou skupinu.

### Co znamená "Znovu ukázat moje série"

Toto tlačítko maže jen lokální filtr ve vašem prohlížeči. Neodstraňuje hlasy,
které už byly uložené na server.

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
- rozhodnutí, jestli jsou dva záběry stejné nebo různé
- potvrzení, že skupina vypadá dobře

V prohlížeči se navíc může ukládat:
- seznam skupin, které se vám dočasně nemají znovu ukazovat v kontrole skupin

Tento lokální seznam je jen pohodlí pro práci. Není to hlavní databáze projektu.

## Když si nejste jistí

Nejlepší pravidlo je: nejisté věci raději nepřepalovat.

Použijte:
- "Další fotka" v opravě polohy
- "Nevím kde přesně", když víte, že poloha je špatně, ale neznáte správný bod
- "Další pár" v kontrole podobných záběrů
- párové porovnání, když skupina vypadá podezřele

I přeskočení je užitečné, protože snižuje riziko špatných oprav.

## Příklady rozhodování

### Příklad: stejná fotografie, jiný sken

Obě strany ukazují stejný dům ze stejného úhlu. Jedna je tmavší a druhá má jiný
ořez.

V kontrole podobných záběrů zvolte:
- "Stejný záběr"

### Příklad: stejná ulice, jiný pohled

Obě fotografie jsou ve stejné ulici, ale jedna míří na sever a druhá na jih.
Domy a kompozice jsou jiné.

V kontrole podobných záběrů zvolte:
- "Různé záběry"

### Příklad: poloha je zjevně o ulici vedle

Fotografie podle popisu i obrazu ukazuje konkrétní dům, ale bod na mapě leží ve
vedlejší ulici.

V opravě polohy zvolte:
- "Nesedí"
- klikněte do mapy na správné místo
- přidejte krátkou poznámku

### Příklad: skupina míchá dvě věci

Ve skupině jsou dvě fotografie stejného náměstí, ale třetí položka ukazuje jinou
ulici.

V kontrole skupin neklikejte na "Série vypadá dobře". Otevřete párové
porovnání nebo skupinu přeskočte.

## Časté potíže

### Ověření se zobrazilo znovu

To se může stát po delší době, v jiném prohlížeči, při smazání cookies nebo při
nové relaci. Dokončete ověření a pokračujte.

### Archivní stránka se nenačítá

Archiv může být pomalý nebo dočasně nedostupný. Zkuste to později nebo položku
přeskočte.

### Na mapě se mi těžko vybírá přesný bod

Přibližte mapu a klikněte co nejpřesněji. Pokud si přesným bodem nejste jistí,
raději použijte "Nevím kde přesně" a doplňte poznámku.

### Už se mi nic neukazuje

Může to znamenat, že pro vás momentálně nezbývá nic dalšího. V kontrole skupin
můžete použít "Znovu ukázat moje série", což obnoví jen lokální seznam v tomto
prohlížeči.

## Shrnutí

- Oprava polohy říká, jestli sedí bod na mapě.
- Kontrola podobných záběrů říká, jestli se mají dvě skupiny sloučit.
- Kontrola skupin říká, jestli jedna skupina vypadá vnitřně správně.

Když budete tyto tři otázky držet odděleně, vaše pomoc bude pro projekt
nejužitečnější.
