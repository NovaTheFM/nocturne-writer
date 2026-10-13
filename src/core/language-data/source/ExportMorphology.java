import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.regex.Pattern;
import morfologik.stemming.Dictionary;
import morfologik.stemming.DictionaryIterator;
import morfologik.stemming.DictionaryLookup;

public class ExportMorphology {
  private static final Pattern INVALID_FORM = Pattern.compile("(?:^|:)bad(?::|$)");
  public static void main(String[] args) throws Exception {
    Path source = Path.of(args[0]), target = Path.of(args[1]);
    Files.createDirectories(target);
    for (String lang : List.of("ru", "uk", "en")) {
      String filename = Map.of("ru", "russian", "uk", "ukrainian", "en", "english").get(lang);
      var location = ExportMorphology.class.getClassLoader().getResource("org/languagetool/resource/" + lang + "/" + filename + ".dict");
      if (location == null) throw new IllegalStateException("Missing morphology dictionary: " + lang);
      var dictionary = Dictionary.read(location);
      Set<String> common = new HashSet<>(), lemmas = new HashSet<>();
      var exactLookup = new DictionaryLookup(dictionary);
      TreeSet<String> properForms = new TreeSet<>();
      for (String word : Files.readAllLines(source.resolve("org/languagetool/resource/" + lang + "/common_words.txt"), StandardCharsets.UTF_8)) {
        if (word.matches("[\\p{L}]+(?:[’'-][\\p{L}]+)*")) {
          String key = word.toLowerCase(Locale.ROOT);
          common.add(key);
          if (Character.isUpperCase(word.charAt(0))) properForms.add(word);
        }
      }
      var iterator = new DictionaryIterator(dictionary, dictionary.metadata.getDecoder(), true);
      while (iterator.hasNext()) {
        var item = iterator.next();
        String tag = item.getTag() == null ? "" : item.getTag().toString();
        if (common.contains(item.getWord().toString().toLowerCase(Locale.ROOT)) || tag.startsWith("VB") || tag.startsWith("verb:")) lemmas.add(item.getStem().toString().toLowerCase(Locale.ROOT));
      }
      TreeSet<String> rows = new TreeSet<>(), allWords = new TreeSet<>();
      iterator = new DictionaryIterator(dictionary, dictionary.metadata.getDecoder(), true);
      while (iterator.hasNext()) {
        var item = iterator.next();
        String word = item.getWord().toString(), stem = item.getStem().toString(), tag = item.getTag() == null ? "" : item.getTag().toString();
        if (!word.matches("[\\p{L}]+(?:[’'-][\\p{L}]+)*")) continue;
        if (INVALID_FORM.matcher(tag).find()) continue;
        allWords.add(word.toLowerCase(Locale.ROOT).replace('ё', 'е'));
        if (Character.isUpperCase(word.charAt(0)) && (lang.equals("ru") || tag.contains(":prop:geo") || tag.equals("NNP") || tag.equals("NNPS"))) properForms.add(word);
        if (!lemmas.contains(stem.toLowerCase(Locale.ROOT))) continue;
        rows.add(word + "\t" + stem + "\t" + tag);
      }
      Files.write(target.resolve(lang + ".tsv"), rows, StandardCharsets.UTF_8);
      Files.write(target.resolve(lang + "-common.txt"), new TreeSet<>(common), StandardCharsets.UTF_8);
      Files.write(target.resolve(lang + "-all.txt"), allWords, StandardCharsets.UTF_8);
      properForms.removeIf(word -> !exactLookup.lookup(word.toLowerCase(Locale.ROOT)).isEmpty());
      Files.write(target.resolve(lang + "-proper.txt"), properForms, StandardCharsets.UTF_8);
      System.out.println(lang + ": common=" + common.size() + ", lemmas=" + lemmas.size() + ", analyses=" + rows.size() + ", validatedForms=" + allWords.size());
    }
  }
}
