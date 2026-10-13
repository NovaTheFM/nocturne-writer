import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.regex.Pattern;
import morfologik.stemming.DictionaryLookup;

public class ValidateReferenceWords {
  public static void main(String[] args) throws Exception {
    var invalid = Pattern.compile("(?:^|:)bad(?::|$)");
    var lookups = new HashMap<String, DictionaryLookup>();
    for (String language : List.of("ru", "uk", "en")) {
      String filename = Map.of("ru", "russian", "uk", "ukrainian", "en", "english").get(language);
      var location = ValidateReferenceWords.class.getClassLoader().getResource("org/languagetool/resource/" + language + "/" + filename + ".dict");
      lookups.put(language, new DictionaryLookup(morfologik.stemming.Dictionary.read(location)));
    }
    var output = new ArrayList<String>();
    for (String line : Files.readAllLines(Path.of(args[0]), StandardCharsets.UTF_8)) {
      String[] fields = line.split("\t");
      var tags = new TreeSet<String>();
      boolean valid = false;
      for (var form : lookups.get(fields[1]).lookup(fields[2])) {
        String tag = form.getTag() == null ? "" : form.getTag().toString();
        tags.add(tag);
        if (!invalid.matcher(tag).find()) valid = true;
      }
      output.add(line + "\t" + valid + "\t" + String.join("|", tags));
    }
    Files.write(Path.of(args[1]), output, StandardCharsets.UTF_8);
  }
}
