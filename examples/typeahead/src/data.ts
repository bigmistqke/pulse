export type City = {
	name: string
	country: string
	population: number
}

export type CityDetail = City & {
	timezone: string
	founded: number
	elevation: number
	rivers: string[]
}

export const CITIES: CityDetail[] = [
	{ name: 'Amsterdam', country: 'Netherlands', population: 921_402, timezone: 'CET', founded: 1275, elevation: -2, rivers: ['Amstel', 'IJ'] },
	{ name: 'Antwerp', country: 'Belgium', population: 536_079, timezone: 'CET', founded: 700, elevation: 7, rivers: ['Scheldt'] },
	{ name: 'Athens', country: 'Greece', population: 643_452, timezone: 'EET', founded: -3000, elevation: 170, rivers: ['Kifisos', 'Ilisos'] },
	{ name: 'Atlanta', country: 'United States', population: 498_715, timezone: 'EST', founded: 1837, elevation: 320, rivers: ['Chattahoochee'] },
	{ name: 'Auckland', country: 'New Zealand', population: 1_463_000, timezone: 'NZST', founded: 1840, elevation: 196, rivers: ['Tamaki'] },
	{ name: 'Barcelona', country: 'Spain', population: 1_620_343, timezone: 'CET', founded: -218, elevation: 12, rivers: ['Besòs', 'Llobregat'] },
	{ name: 'Belgrade', country: 'Serbia', population: 1_197_714, timezone: 'CET', founded: -279, elevation: 117, rivers: ['Sava', 'Danube'] },
	{ name: 'Berlin', country: 'Germany', population: 3_677_472, timezone: 'CET', founded: 1237, elevation: 34, rivers: ['Spree', 'Havel'] },
	{ name: 'Bogotá', country: 'Colombia', population: 7_412_566, timezone: 'COT', founded: 1538, elevation: 2640, rivers: ['Bogotá'] },
	{ name: 'Boston', country: 'United States', population: 675_647, timezone: 'EST', founded: 1630, elevation: 43, rivers: ['Charles', 'Mystic'] },
	{ name: 'Bratislava', country: 'Slovakia', population: 475_503, timezone: 'CET', founded: 907, elevation: 134, rivers: ['Danube', 'Morava'] },
	{ name: 'Bristol', country: 'United Kingdom', population: 472_400, timezone: 'GMT', founded: 1000, elevation: 11, rivers: ['Avon', 'Frome'] },
	{ name: 'Budapest', country: 'Hungary', population: 1_752_286, timezone: 'CET', founded: 89, elevation: 102, rivers: ['Danube'] },
	{ name: 'Buenos Aires', country: 'Argentina', population: 3_075_646, timezone: 'ART', founded: 1536, elevation: 25, rivers: ['Río de la Plata'] },
	{ name: 'Cairo', country: 'Egypt', population: 9_539_000, timezone: 'EET', founded: 969, elevation: 23, rivers: ['Nile'] },
	{ name: 'Cape Town', country: 'South Africa', population: 4_618_000, timezone: 'SAST', founded: 1652, elevation: 25, rivers: ['Liesbeek'] },
	{ name: 'Copenhagen', country: 'Denmark', population: 660_842, timezone: 'CET', founded: 1043, elevation: 24, rivers: ['Harrestrup Å'] },
	{ name: 'Dublin', country: 'Ireland', population: 592_713, timezone: 'GMT', founded: 841, elevation: 20, rivers: ['Liffey', 'Dodder'] },
	{ name: 'Edinburgh', country: 'United Kingdom', population: 526_470, timezone: 'GMT', founded: 1125, elevation: 47, rivers: ['Water of Leith'] },
	{ name: 'Ghent', country: 'Belgium', population: 265_086, timezone: 'CET', founded: 630, elevation: 6, rivers: ['Scheldt', 'Leie'] },
	{ name: 'Hamburg', country: 'Germany', population: 1_906_411, timezone: 'CET', founded: 808, elevation: 6, rivers: ['Elbe', 'Alster'] },
	{ name: 'Helsinki', country: 'Finland', population: 658_864, timezone: 'EET', founded: 1550, elevation: 26, rivers: ['Vantaa'] },
	{ name: 'Istanbul', country: 'Turkey', population: 15_519_267, timezone: 'TRT', founded: -660, elevation: 39, rivers: ['Golden Horn'] },
	{ name: 'Lisbon', country: 'Portugal', population: 544_851, timezone: 'WET', founded: -1200, elevation: 100, rivers: ['Tagus'] },
	{ name: 'Ljubljana', country: 'Slovenia', population: 295_504, timezone: 'CET', founded: 1144, elevation: 295, rivers: ['Ljubljanica', 'Sava'] },
	{ name: 'London', country: 'United Kingdom', population: 8_982_000, timezone: 'GMT', founded: 47, elevation: 11, rivers: ['Thames', 'Lea'] },
	{ name: 'Madrid', country: 'Spain', population: 3_223_334, timezone: 'CET', founded: 865, elevation: 650, rivers: ['Manzanares'] },
	{ name: 'Melbourne', country: 'Australia', population: 5_078_193, timezone: 'AEST', founded: 1835, elevation: 31, rivers: ['Yarra', 'Maribyrnong'] },
	{ name: 'Montreal', country: 'Canada', population: 1_762_949, timezone: 'EST', founded: 1642, elevation: 233, rivers: ['Saint Lawrence'] },
	{ name: 'Nairobi', country: 'Kenya', population: 4_397_073, timezone: 'EAT', founded: 1899, elevation: 1795, rivers: ['Nairobi'] },
	{ name: 'Naples', country: 'Italy', population: 913_462, timezone: 'CET', founded: -600, elevation: 17, rivers: ['Sebeto'] },
	{ name: 'Oslo', country: 'Norway', population: 709_037, timezone: 'CET', founded: 1040, elevation: 23, rivers: ['Akerselva'] },
	{ name: 'Porto', country: 'Portugal', population: 231_962, timezone: 'WET', founded: -300, elevation: 104, rivers: ['Douro'] },
	{ name: 'Prague', country: 'Czechia', population: 1_309_000, timezone: 'CET', founded: 885, elevation: 200, rivers: ['Vltava'] },
	{ name: 'Reykjavik', country: 'Iceland', population: 135_688, timezone: 'GMT', founded: 874, elevation: 61, rivers: ['Elliðaá'] },
	{ name: 'Riga', country: 'Latvia', population: 605_802, timezone: 'EET', founded: 1201, elevation: 6, rivers: ['Daugava'] },
	{ name: 'Rome', country: 'Italy', population: 2_860_009, timezone: 'CET', founded: -753, elevation: 21, rivers: ['Tiber', 'Aniene'] },
	{ name: 'Rotterdam', country: 'Netherlands', population: 651_446, timezone: 'CET', founded: 1270, elevation: 0, rivers: ['Nieuwe Maas'] },
	{ name: 'San Francisco', country: 'United States', population: 815_201, timezone: 'PST', founded: 1776, elevation: 16, rivers: ['Islais Creek'] },
	{ name: 'Santiago', country: 'Chile', population: 6_310_000, timezone: 'CLT', founded: 1541, elevation: 570, rivers: ['Mapocho'] },
	{ name: 'Seoul', country: 'South Korea', population: 9_733_509, timezone: 'KST', founded: -18, elevation: 38, rivers: ['Han'] },
	{ name: 'Stockholm', country: 'Sweden', population: 975_551, timezone: 'CET', founded: 1252, elevation: 28, rivers: ['Norrström'] },
	{ name: 'Tallinn', country: 'Estonia', population: 445_082, timezone: 'EET', founded: 1219, elevation: 9, rivers: ['Pirita'] },
	{ name: 'Tokyo', country: 'Japan', population: 13_960_000, timezone: 'JST', founded: 1457, elevation: 40, rivers: ['Sumida', 'Arakawa'] },
	{ name: 'Toronto', country: 'Canada', population: 2_794_356, timezone: 'EST', founded: 1793, elevation: 76, rivers: ['Don', 'Humber'] },
	{ name: 'Utrecht', country: 'Netherlands', population: 361_924, timezone: 'CET', founded: 47, elevation: 5, rivers: ['Vecht', 'Kromme Rijn'] },
	{ name: 'Valencia', country: 'Spain', population: 789_744, timezone: 'CET', founded: -138, elevation: 15, rivers: ['Turia'] },
	{ name: 'Vienna', country: 'Austria', population: 1_920_949, timezone: 'CET', founded: -15, elevation: 151, rivers: ['Danube', 'Wien'] },
	{ name: 'Warsaw', country: 'Poland', population: 1_790_658, timezone: 'CET', founded: 1300, elevation: 100, rivers: ['Vistula'] },
	{ name: 'Zurich', country: 'Switzerland', population: 421_878, timezone: 'CET', founded: -15, elevation: 408, rivers: ['Limmat', 'Sihl'] },
]
