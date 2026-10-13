import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import morfologik.fsa.builders.FSABuilder;
import morfologik.fsa.builders.CFSA2Serializer;

public class BuildWordFsa {
  public static void main(String[] args) throws Exception {
    Path source = Path.of(args[0]);
    for (String language : new String[] {"ru", "uk", "en"}) {
      FSABuilder builder = new FSABuilder();
      try (var lines = Files.lines(source.resolve(language + "-all.txt"), StandardCharsets.UTF_8)) {
        lines.forEach(word -> { byte[] bytes = word.getBytes(StandardCharsets.UTF_8); builder.add(bytes, 0, bytes.length); });
      }
      try (var output = Files.newOutputStream(source.resolve(language + "-words.fsa"))) { new CFSA2Serializer().serialize(builder.complete(), output); }
      System.out.println(language + ": exact word index " + Files.size(source.resolve(language + "-words.fsa")) + " bytes");
    }
  }
}
