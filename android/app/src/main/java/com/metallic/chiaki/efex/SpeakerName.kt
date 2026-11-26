// SPDX-License-Identifier: LicenseRef-AGPL-3.0-only-OpenSSL
// Efex Sub: altyazıdaki konuşan adı ("Lucia: Arabaya bin.") ve karakter–ses eşleşmeleri.

package com.metallic.chiaki.efex

import android.content.Context

object SpeakerName
{
	/** "Ad: replik" — ad en fazla 3 kelime, büyük harfle başlar */
	private val PATTERN = Regex("^([A-ZÇĞİÖŞÜ][\\p{L}'.\\-]*(?: [A-Z0-9][\\p{L}'.\\-]*){0,2})\\s?[:;]\\s+(.+)$")

	/** Tek bir kişi olmayan genel adlar: sesleri kilitlenmez, adları Türkçeye çevrilir */
	private val GENERIC = mapOf(
		"man" to "Adam", "woman" to "Kadın", "guy" to "Adam", "girl" to "Kız", "boy" to "Çocuk", "kid" to "Çocuk",
		"cop" to "Polis", "police" to "Polis", "officer" to "Memur", "guard" to "Gardiyan", "security" to "Güvenlik",
		"driver" to "Şoför", "pedestrian" to "Yaya", "stranger" to "Yabancı", "bystander" to "Seyirci",
		"radio" to "Radyo", "tv" to "TV", "announcer" to "Spiker", "dispatcher" to "Telsiz", "dispatch" to "Telsiz",
		"pilot" to "Pilot", "cashier" to "Kasiyer", "clerk" to "Görevli", "worker" to "İşçi", "doctor" to "Doktor",
		"nurse" to "Hemşire", "gang member" to "Çete üyesi", "gangster" to "Gangster", "thug" to "Serseri",
		"crowd" to "Kalabalık", "all" to "Hepsi", "both" to "İkisi", "voice" to "Ses", "unknown" to "Bilinmeyen",
		"caller" to "Arayan", "operator" to "Operatör", "reporter" to "Muhabir", "host" to "Sunucu", "dj" to "DJ",
		"bartender" to "Barmen", "waiter" to "Garson", "customer" to "Müşteri", "shopkeeper" to "Dükkâncı",
		"soldier" to "Asker", "agent" to "Ajan", "fbi agent" to "FBI ajanı", "biker" to "Motorcu", "hooker" to "Hayat kadını")

	/** Ad değil, cümlenin parçası olan kelimeler ("Listen: …", "Objective: …") */
	private val NOT_NAMES = setOf("listen", "look", "note", "okay", "ok", "yes", "no", "well", "hey", "so", "and", "but",
		"rule", "tip", "hint", "warning", "objective", "mission", "goal", "reward", "bonus", "time", "step", "now", "remember",
		"first", "second", "then", "next", "fine", "sure", "right", "wait", "see", "the thing is", "point is")

	class Split(val name: String?, val line: String, val generic: Boolean)

	fun split(text: String): Split
	{
		val m = PATTERN.find(text.trim()) ?: return Split(null, text, false)
		val rawName = m.groupValues[1].trim().trimEnd('.')
		val line = m.groupValues[2].trim()
		if(rawName.length > 24 || line.count { it.isLetter() } < 2 || rawName.lowercase() in NOT_NAMES)
			return Split(null, text, false)
		val generic = GENERIC[rawName.lowercase()]
		if(generic != null)
			return Split(generic, line, true)
		// "LUCIA" → "Lucia"
		val pretty = if(rawName == rawName.uppercase())
			rawName.lowercase().split(" ").joinToString(" ") { it.replaceFirstChar { c -> c.titlecase() } }
		else rawName
		return Split(pretty, line, false)
	}

	// ---- Karakter → ses (TV'de saklanır, sonraki oyunlarda da aynı ses)

	private const val PREFS = "efex_voices"

	fun load(context: Context, name: String): Pair<String, String>?
	{
		val v = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(name.lowercase(), null) ?: return null
		val parts = v.split("|")
		if(parts.size != 2 || DubbingEngine.VOICES[parts[0]]?.contains(parts[1]) != true)
			return null
		return parts[0] to parts[1]
	}

	fun save(context: Context, name: String, persona: String, voice: String) =
		context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(name.lowercase(), "$persona|$voice").apply()

	/** Bu gruptaki seslerin kaç karaktere verildiği */
	fun usage(context: Context, persona: String): Map<String, Int> =
		context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).all.values
			.mapNotNull { (it as? String)?.split("|") }
			.filter { it.size == 2 && it[0] == persona }
			.groupingBy { it[1] }.eachCount()

	fun count(context: Context): Int = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).all.size

	fun reset(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply()
}
